import {
  getUniqId, request, i18n, buffer2string,
} from '#/common';
import cache from './cache';
import { isUserScript, parseMeta } from './script';
import { getScriptByIdSync } from './db';
import { openerTabIdSupported } from './tabs';

const requests = {};
const verify = {};
const specialHeaders = [
  'user-agent',
  // https://developer.mozilla.org/en-US/docs/Glossary/Forbidden_header_name
  // https://cs.chromium.org/?q=file:cc+symbol:IsForbiddenHeader%5Cb
  'accept-charset',
  'accept-encoding',
  'access-control-request-headers',
  'access-control-request-method',
  'connection',
  'content-length',
  'cookie',
  'cookie2',
  'date',
  'dnt',
  'expect',
  'host',
  'keep-alive',
  'origin',
  'referer',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'via',
];
// const tasks = {};

export function getRequestId() {
  const id = getUniqId();
  requests[id] = {
    id,
    xhr: new XMLHttpRequest(),
  };
  return id;
}

function xhrCallbackWrapper(req) {
  let lastPromise = Promise.resolve();
  const { xhr } = req;
  return (evt) => {
    const res = {
      id: req.id,
      type: evt.type,
      resType: xhr.responseType,
    };
    const data = {
      finalUrl: xhr.responseURL,
      readyState: xhr.readyState,
      responseHeaders: xhr.getAllResponseHeaders(),
      status: xhr.status,
      statusText: xhr.statusText,
    };
    res.data = data;
    try {
      data.responseText = xhr.responseText;
    } catch (e) {
      // ignore if responseText is unreachable
    }
    if (evt.type === 'progress') {
      ['lengthComputable', 'loaded', 'total'].forEach((key) => {
        data[key] = evt[key];
      });
    }
    if (evt.type === 'loadend') clearRequest(req);
    lastPromise = lastPromise.then(() => {
      if (xhr.response && xhr.responseType === 'arraybuffer') {
        const contentType = xhr.getResponseHeader('Content-Type') || 'application/octet-stream';
        const binstring = buffer2string(xhr.response);
        data.response = `data:${contentType};base64,${window.btoa(binstring)}`;
      } else {
        // default `null` for blob and '' for text
        data.response = xhr.response;
      }
    })
    .then(() => {
      if (req.cb) req.cb(res);
    });
  };
}

function isSpecialHeader(lowerHeader) {
  return specialHeaders.includes(lowerHeader)
    || lowerHeader.startsWith('proxy-')
    || lowerHeader.startsWith('sec-');
}

export function httpRequest(details, cb) {
  const req = requests[details.id];
  if (!req || req.cb) return;
  req.cb = cb;
  req.anonymous = details.anonymous;
  const { xhr } = req;
  try {
    xhr.open(details.method, details.url, true, details.user || '', details.password || '');
    xhr.setRequestHeader('VM-Verify', details.id);
    if (details.headers) {
      Object.keys(details.headers).forEach((key) => {
        const lowerKey = key.toLowerCase();
        // `VM-` headers are reserved
        if (lowerKey.startsWith('vm-')) return;
        xhr.setRequestHeader(
          isSpecialHeader(lowerKey) ? `VM-${key}` : key,
          details.headers[key],
        );
      });
    }
    if (details.timeout) xhr.timeout = details.timeout;
    if (details.responseType) xhr.responseType = 'arraybuffer';
    if (details.overrideMimeType) xhr.overrideMimeType(details.overrideMimeType);
    const callback = xhrCallbackWrapper(req);
    [
      'abort',
      'error',
      'load',
      'loadend',
      'progress',
      'readystatechange',
      'timeout',
    ]
    .forEach((evt) => { xhr[`on${evt}`] = callback; });
    // req.finalUrl = details.url;
    const { data } = details;
    const body = data ? decodeBody(data) : null;
    xhr.send(body);
  } catch (e) {
    const { scriptId } = req;
    console.warn(e, `in script id ${scriptId}, ${getScriptByIdSync(scriptId).meta.name}`);
  }
}

function clearRequest(req) {
  if (req.coreId) delete verify[req.coreId];
  delete requests[req.id];
}

export function abortRequest(id) {
  const req = requests[id];
  if (req) {
    req.xhr.abort();
    clearRequest(req);
  }
}

function decodeBody(obj) {
  const { cls, value } = obj;
  if (cls === 'formdata') {
    const result = new FormData();
    if (value) {
      Object.keys(value).forEach((key) => {
        value[key].forEach((item) => {
          result.append(key, decodeBody(item));
        });
      });
    }
    return result;
  }
  if (['blob', 'file'].includes(cls)) {
    const { type, name, lastModified } = obj;
    const array = new Uint8Array(value.length);
    for (let i = 0; i < value.length; i += 1) array[i] = value.charCodeAt(i);
    const data = [array.buffer];
    if (cls === 'file') return new File(data, name, { type, lastModified });
    return new Blob(data, { type });
  }
  if (value) return JSON.parse(value);
}

// Watch URL redirects
// browser.webRequest.onBeforeRedirect.addListener(details => {
//   const reqId = verify[details.requestId];
//   if (reqId) {
//     const req = requests[reqId];
//     if (req) req.finalUrl = details.redirectUrl;
//   }
// }, {
//   urls: ['<all_urls>'],
//   types: ['xmlhttprequest'],
// });

// Modifications on headers
{
  function onBeforeSendHeaders(details) {
    const headers = details.requestHeaders;
    let newHeaders = [];
    const vmHeaders = {};
    headers.forEach((header) => {
      // if (header.name === 'VM-Task') {
      //   tasks[details.requestId] = header.value;
      // } else
      if (header.name.startsWith('VM-')) {
        vmHeaders[header.name.slice(3)] = header.value;
      } else {
        newHeaders.push(header);
      }
    });
    const reqId = vmHeaders.Verify;
    if (reqId) {
      const req = requests[reqId];
      if (req) {
        delete vmHeaders.Verify;
        verify[details.requestId] = reqId;
        req.coreId = details.requestId;
        Object.keys(vmHeaders).forEach((name) => {
          if (isSpecialHeader(name.toLowerCase())) {
            newHeaders.push({ name, value: vmHeaders[name] });
          }
        });
        if (req.anonymous) {
          // Drop cookie in anonymous mode
          newHeaders = newHeaders.filter(({ name }) => name.toLowerCase() !== 'cookie');
        }
      }
    }
    return { requestHeaders: newHeaders };
  }
  const filter = {
    urls: ['<all_urls>'],
    types: ['xmlhttprequest'],
  };
  try {
    browser.webRequest.onBeforeSendHeaders.addListener(
      onBeforeSendHeaders,
      filter,
      ['blocking', 'requestHeaders', 'extraHeaders'],
    );
  } catch {
    // extraHeaders is supported since Chrome v72
    browser.webRequest.onBeforeSendHeaders.addListener(
      onBeforeSendHeaders,
      filter,
      ['blocking', 'requestHeaders'],
    );
  }
}

// tasks are not necessary now, turned off
// Stop redirects
// browser.webRequest.onHeadersReceived.addListener(details => {
//   const task = tasks[details.requestId];
//   if (task) {
//     delete tasks[details.requestId];
//     if (task === 'Get-Location' && [301, 302, 303].includes(details.statusCode)) {
//       const locationHeader = details.responseHeaders.find(
//         header => header.name.toLowerCase() === 'location');
//       const base64 = locationHeader && locationHeader.value;
//       return {
//         redirectUrl: `data:text/plain;charset=utf-8,${base64 || ''}`,
//       };
//     }
//   }
// }, {
//   urls: ['<all_urls>'],
//   types: ['xmlhttprequest'],
// }, ['blocking', 'responseHeaders']);
// browser.webRequest.onCompleted.addListener(details => {
//   delete tasks[details.requestId];
// }, {
//   urls: ['<all_urls>'],
//   types: ['xmlhttprequest'],
// });
// browser.webRequest.onErrorOccurred.addListener(details => {
//   delete tasks[details.requestId];
// }, {
//   urls: ['<all_urls>'],
//   types: ['xmlhttprequest'],
// });

export async function confirmInstall(info, src = {}) {
  const { url, from } = info;
  const code = info.code || (await request(url)).data;
  // TODO: display the error in UI
  if (!isUserScript(code)) throw i18n('msgInvalidScript');
  cache.put(url, code, 3000);
  const confirmKey = getUniqId();
  cache.put(`confirm-${confirmKey}`, { url, from });
  browser.tabs.create({
    url: `/confirm/index.html#${confirmKey}`,
    index: src.tab ? src.tab.index + 1 : undefined,
    ...src.tab && openerTabIdSupported ? { openerTabId: src.tab.id } : {},
  });
}

const whitelist = [
  '^https://greasyfork.org/scripts/[^/]*/code/[^/]*?\\.user\\.js([?#]|$)',
  '^https://openuserjs.org/install/[^/]*/[^/]*?\\.user\\.js([?#]|$)',
  '^https://github.com/[^/]*/[^/]*/raw/[^/]*/[^/]*?\\.user\\.js([?#]|$)',
  '^https://gist.github.com/.*?/[^/]*?.user.js([?#]|$)',
].map(re => new RegExp(re));
const blacklist = [
  '//(?:(?:gist.|)github.com|greasyfork.org|openuserjs.org)/',
].map(re => new RegExp(re));
const bypass = {};
const extensionRoot = browser.runtime.getURL('/');

browser.tabs.onCreated.addListener((tab) => {
  if (/\.user\.js([?#]|$)/.test(tab.pendingUrl || tab.url)) {
    cache.put(`autoclose:${tab.id}`, true, 1000);
  }
});

browser.webRequest.onBeforeRequest.addListener((req) => {
  // onBeforeRequest fired for `file:`
  // - works on Chrome
  // - does not work on Firefox
  const { url } = req;
  if (req.method === 'GET') {
    // open a real URL for simplified userscript URL listed in devtools of the web page
    if (url.startsWith(extensionRoot)) {
      const id = +url.split('#').pop();
      const redirectUrl = `${extensionRoot}options/index.html#scripts/${id}`;
      return { redirectUrl };
    }
    if (!bypass[url] && (
      whitelist.some(re => re.test(url)) || !blacklist.some(re => re.test(url))
    )) {
      Promise.all([
        request(url).catch(() => ({ data: '' })),
        req.tabId < 0 ? Promise.resolve() : browser.tabs.get(req.tabId),
      ])
      .then(([{ data: code }, tab]) => {
        const meta = parseMeta(code);
        if (meta.name) {
          confirmInstall({
            code,
            url,
            // Chrome 79+ uses pendingUrl while the tab connects to the newly navigated URL
            from: tab && (tab.pendingUrl || tab.url),
          }, { tab });
          if (cache.has(`autoclose:${req.tabId}`)) {
            browser.tabs.remove(req.tabId);
          }
        } else {
          if (!bypass[url]) {
            bypass[url] = {
              timer: setTimeout(() => {
                delete bypass[url];
              }, 10000),
            };
          }
          if (tab && tab.id) {
            browser.tabs.update(tab.id, { url });
          }
        }
      });
      // { cancel: true } will redirect to a blocked view
      return { redirectUrl: 'javascript:history.back()' }; // eslint-disable-line no-script-url
    }
  }
}, {
  urls: [
    // 1. *:// comprises only http/https
    // 2. the API ignores #hash part
    '*://*/*.user.js',
    '*://*/*.user.js?*',
    'file://*/*.user.js',
    'file://*/*.user.js?*',
    `${extensionRoot}*.user.js`,
  ],
  types: ['main_frame'],
}, ['blocking']);
