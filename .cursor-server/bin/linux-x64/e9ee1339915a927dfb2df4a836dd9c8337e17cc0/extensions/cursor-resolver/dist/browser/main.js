/******/ (() => { // webpackBootstrap
/******/ 	"use strict";
/******/ 	var __webpack_modules__ = ([
/* 0 */,
/* 1 */
/***/ ((module) => {

module.exports = require("vscode");

/***/ }),
/* 2 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   BackgroundComposerAuthorityResolver: () => (/* binding */ BackgroundComposerAuthorityResolver)
/* harmony export */ });
/* harmony import */ var vscode__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(1);
/* harmony import */ var vscode__WEBPACK_IMPORTED_MODULE_0___default = /*#__PURE__*/__webpack_require__.n(vscode__WEBPACK_IMPORTED_MODULE_0__);
/* harmony import */ var _src_vs_base_common_cursorSocketCloseError_js__WEBPACK_IMPORTED_MODULE_1__ = __webpack_require__(3);
/* harmony import */ var _cursorServerUrlRetry_js__WEBPACK_IMPORTED_MODULE_2__ = __webpack_require__(4);



function toTemporarilyNotAvailableIfCursorSocketTransient(error) {
  if (!(error instanceof Error)) {
    return error;
  }
  if (error.code === _src_vs_base_common_cursorSocketCloseError_js__WEBPACK_IMPORTED_MODULE_1__.CURSOR_SOCKET_CLOSE_ERROR_CODE_TRANSIENT) {
    return vscode__WEBPACK_IMPORTED_MODULE_0__.RemoteAuthorityResolverError.TemporarilyNotAvailable(error.message);
  }
  return error;
}
let _outputChannel;
function initLogger(outputChannel) {
  _outputChannel = outputChannel;
}
function log(...args) {
  const msg = args.map(String).join(" ");
  console.log(`[cursor-resolver]  ${msg}`);
  _outputChannel?.appendLine(`[INFO]  ${msg}`);
}
function logError(...args) {
  const msg = args.map(String).join(" ");
  _outputChannel?.appendLine(`[ERROR] ${msg}`);
}
function isCursorServerReservedPort(port) {
  return port >= 26e3 && port <= 26999;
}
function isFilteredBackgroundComposerPort(port) {
  if (isCursorServerReservedPort(port)) {
    return true;
  }
  if (port >= 5870 && port <= 5890) {
    return true;
  }
  if (port === 2375 || port === 5901 || port === 50052) {
    return true;
  }
  return false;
}
function getProductCommit() {
  const commit = vscode__WEBPACK_IMPORTED_MODULE_0__.cursor.productCommit ?? vscode__WEBPACK_IMPORTED_MODULE_0__.cursor.cursorServerCommit;
  if (!commit || !/^[a-zA-Z0-9\-_.]+$/.test(commit)) {
    logError("Invalid or missing product commit", commit);
    throw new Error("Invalid or missing product commit");
  }
  return commit;
}
function reportMetric(name, value) {
  try {
    vscode__WEBPACK_IMPORTED_MODULE_0__.cursor.metricsDistribution({
      stat: `background-composer.${name}`,
      value,
      tags: {}
    });
  } catch {
  }
}
class BackgroundComposerAuthorityResolver {
  constructor(connectionTokenProvider, outputChannel) {
    this.connectionTokenProvider = connectionTokenProvider;
    this.alwaysShowPortsView = true;
    initLogger(outputChannel);
    log("RemoteAuthorityResolver constructor");
  }
  createManagedResolvedAuthority(makeConnection, connectionToken, tunnelFactory) {
    return Object.assign(
      new vscode__WEBPACK_IMPORTED_MODULE_0__.ManagedResolvedAuthority(
        makeConnection,
        connectionToken,
        tunnelFactory
      ),
      {
        skipCreateInspectTunnel: true
      }
    );
  }
  /**
   * Filter out cursor-server reserved ports from being shown as candidates.
   * These ports (26000-26999) are used by cursor-server infrastructure and
   * should not be offered as port forwards in background composers.
   */
  async showCandidatePort(_host, port, _detail) {
    if (isFilteredBackgroundComposerPort(port)) {
      log(`Filtering out reserved/internal port ${port} from candidates`);
      return false;
    }
    return true;
  }
  async getCursorServerUrl(authority, useCache = true) {
    const indexOfPlus = authority.indexOf("+");
    const bcIdOrUrl = authority.substring(indexOfPlus + 1).trim();
    if (indexOfPlus === -1 || bcIdOrUrl.length === 0) {
      throw new Error("No bcId found in authority");
    }
    if (bcIdOrUrl.startsWith("{")) {
      try {
        return JSON.parse(bcIdOrUrl);
      } catch (e) {
        throw new Error("Invalid url found in authority");
      }
    }
    const bcId = bcIdOrUrl;
    const commit = getProductCommit();
    return await withTimer("getCursorServerUrl", async () => {
      try {
        return await this.connectionTokenProvider.getOrCreateCursorServerUrl(
          bcId,
          commit,
          useCache
        );
      } catch (error) {
        logError("Error getting cursor server url", error);
        throw error;
      }
    });
  }
  async getCursorServerUrlWithRetry(authority, initialUseCache = true) {
    return (0,_cursorServerUrlRetry_js__WEBPACK_IMPORTED_MODULE_2__.retryGetCursorServerUrl)({
      initialUseCache,
      getCursorServerUrl: (useCache) => this.getCursorServerUrl(authority, useCache),
      onRetry: (error, attempt, delayMs) => {
        const delayDescription = delayMs > 0 ? `retrying in ${delayMs / 1e3}s` : "retrying immediately";
        log(
          "Error getting cursor server url,",
          delayDescription,
          `attempt=${attempt}`,
          error
        );
      }
    });
  }
  async resolve(authority, context, progress) {
    return withTimer("resolve", async () => {
      log("resolve", authority, `resolveAttempt=${context.resolveAttempt}`);
      progress?.report({ phase: "init" });
      const indexOfPlus = authority.indexOf("+");
      const bcIdOrUrl = authority.substring(indexOfPlus + 1).trim();
      if (indexOfPlus === -1 || bcIdOrUrl.length === 0) {
        throw new Error("No bcId found in authority");
      }
      if (bcIdOrUrl.startsWith("{")) {
        let url;
        try {
          url = JSON.parse(bcIdOrUrl);
        } catch (e) {
          throw new Error("Invalid url found in authority");
        }
        log("resolved url (inline)", url.host, url.port);
        const makeConnection2 = async () => {
          try {
            return await createManagedTcpConnection(url);
          } catch (error) {
            throw toTemporarilyNotAvailableIfCursorSocketTransient(error);
          }
        };
        const tunnelFactory2 = vscode__WEBPACK_IMPORTED_MODULE_0__.cursor.createSocketConsumerTunnelFactory({
          makeConnection: makeConnection2,
          connectionToken: url.connectionToken
        });
        return this.createManagedResolvedAuthority(
          makeConnection2,
          url.connectionToken,
          tunnelFactory2
        );
      }
      const bcId = bcIdOrUrl;
      progress?.report({ phase: "auth" });
      const commit = getProductCommit();
      const { connectionToken } = await this.connectionTokenProvider.getOrCreateConnectionToken(bcId, commit);
      progress?.report({ phase: "get-url" });
      const urlPromise = this.getCursorServerUrlWithRetry(authority, context.resolveAttempt < 3);
      const makeConnection = async () => {
        progress?.report({ phase: "connect" });
        const url = await urlPromise;
        log("resolved url", url.host, url.port);
        progress?.report({ phase: "socket" });
        try {
          return await createManagedTcpConnection(url);
        } catch (error) {
          throw toTemporarilyNotAvailableIfCursorSocketTransient(error);
        }
      };
      const tunnelFactory = vscode__WEBPACK_IMPORTED_MODULE_0__.cursor.createSocketConsumerTunnelFactory({
        makeConnection,
        connectionToken
      });
      return this.createManagedResolvedAuthority(
        makeConnection,
        connectionToken,
        tunnelFactory
      );
    });
  }
}
async function createManagedTcpConnection(url) {
  const useTls = url.port === 443;
  const tcpConn = await vscode__WEBPACK_IMPORTED_MODULE_0__.cursor.createTcpConnection({
    host: url.host,
    port: url.port,
    tls: useTls ? { rejectUnauthorized: true, servername: url.host } : void 0
  });
  log("tcp connection established", `${url.host}:${url.port}`, useTls ? "(tls)" : "(plain)");
  const dataEmitter = new vscode__WEBPACK_IMPORTED_MODULE_0__.EventEmitter();
  const closeEmitter = new vscode__WEBPACK_IMPORTED_MODULE_0__.EventEmitter();
  const endEmitter = new vscode__WEBPACK_IMPORTED_MODULE_0__.EventEmitter();
  tcpConn.onDidReceiveData((data) => dataEmitter.fire(data));
  tcpConn.onDidClose((err) => {
    closeEmitter.fire(err);
    endEmitter.fire();
  });
  return {
    onDidReceiveMessage: dataEmitter.event,
    onDidClose: closeEmitter.event,
    onDidEnd: endEmitter.event,
    send: (data) => {
      tcpConn.send(data);
    },
    end: () => {
      tcpConn.close();
    },
    connectionOptions: {
      headers: [
        `Host: ${url.host}:${url.port}`,
        ...url.headers.map((h) => `${h.key}: ${h.value}`)
      ],
      doNotIncludeWsLocalhostPrefix: true
    }
  };
}
async function withTimer(name, fn) {
  const start = performance.now();
  try {
    return await fn();
  } finally {
    const end = performance.now();
    reportMetric(name, end - start);
  }
}


/***/ }),
/* 3 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   CURSOR_SOCKET_CLOSE_ERROR_CODE_TRANSIENT: () => (/* binding */ CURSOR_SOCKET_CLOSE_ERROR_CODE_TRANSIENT)
/* harmony export */ });
const CURSOR_SOCKET_CLOSE_ERROR_CODE_TRANSIENT = "CursorSocketTransient";


/***/ }),
/* 4 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   getCursorServerUrlRetryDelayMs: () => (/* binding */ getCursorServerUrlRetryDelayMs),
/* harmony export */   retryGetCursorServerUrl: () => (/* binding */ retryGetCursorServerUrl),
/* harmony export */   shouldRetryCursorServerUrlError: () => (/* binding */ shouldRetryCursorServerUrlError)
/* harmony export */ });
/* harmony import */ var _connectrpc_connect__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(5);
/* harmony import */ var _connectrpc_connect__WEBPACK_IMPORTED_MODULE_1__ = __webpack_require__(6);

const CURSOR_SERVER_URL_RETRY_DELAYS_MS = [
  0,
  5e3,
  5e3,
  1e4,
  1e4,
  1e4,
  3e4,
  3e4,
  6e4
];
function getCursorServerUrlRetryDelayMs(attempt) {
  return CURSOR_SERVER_URL_RETRY_DELAYS_MS[Math.min(attempt, CURSOR_SERVER_URL_RETRY_DELAYS_MS.length - 1)];
}
function shouldRetryCursorServerUrlError(error) {
  const code = getConnectErrorCode(error);
  return code === _connectrpc_connect__WEBPACK_IMPORTED_MODULE_0__.Code.DeadlineExceeded || code === _connectrpc_connect__WEBPACK_IMPORTED_MODULE_0__.Code.Unavailable;
}
async function retryGetCursorServerUrl({
  getCursorServerUrl,
  initialUseCache,
  sleep = defaultSleep,
  onRetry
}) {
  let useCache = initialUseCache;
  for (let attempt = 0; ; attempt++) {
    try {
      return await getCursorServerUrl(useCache);
    } catch (error) {
      if (!shouldRetryCursorServerUrlError(error)) {
        throw error;
      }
      const delayMs = getCursorServerUrlRetryDelayMs(attempt);
      onRetry?.(error, attempt + 1, delayMs);
      if (delayMs > 0) {
        await sleep(delayMs);
      }
      useCache = false;
    }
  }
}
async function defaultSleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
function getConnectErrorCode(error) {
  if (error instanceof _connectrpc_connect__WEBPACK_IMPORTED_MODULE_1__.ConnectError) {
    return error.code;
  }
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return void 0;
  }
  return typeof error.code === "number" ? error.code : void 0;
}


/***/ }),
/* 5 */
/***/ ((__unused_webpack___webpack_module__, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   Code: () => (/* binding */ Code)
/* harmony export */ });
// Copyright 2021-2024 The Connect Authors
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//      http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.
/**
 * Connect represents categories of errors as codes, and each code maps to a
 * specific HTTP status code. The codes and their semantics were chosen to
 * match gRPC. Only the codes below are valid — there are no user-defined
 * codes.
 *
 * See the specification at https://connectrpc.com/docs/protocol#error-codes
 * for details.
 */
var Code;
(function (Code) {
    /**
     * Canceled, usually be the user
     */
    Code[Code["Canceled"] = 1] = "Canceled";
    /**
     * Unknown error
     */
    Code[Code["Unknown"] = 2] = "Unknown";
    /**
     * Argument invalid regardless of system state
     */
    Code[Code["InvalidArgument"] = 3] = "InvalidArgument";
    /**
     * Operation expired, may or may not have completed.
     */
    Code[Code["DeadlineExceeded"] = 4] = "DeadlineExceeded";
    /**
     * Entity not found.
     */
    Code[Code["NotFound"] = 5] = "NotFound";
    /**
     * Entity already exists.
     */
    Code[Code["AlreadyExists"] = 6] = "AlreadyExists";
    /**
     * Operation not authorized.
     */
    Code[Code["PermissionDenied"] = 7] = "PermissionDenied";
    /**
     * Quota exhausted.
     */
    Code[Code["ResourceExhausted"] = 8] = "ResourceExhausted";
    /**
     * Argument invalid in current system state.
     */
    Code[Code["FailedPrecondition"] = 9] = "FailedPrecondition";
    /**
     * Operation aborted.
     */
    Code[Code["Aborted"] = 10] = "Aborted";
    /**
     * Out of bounds, use instead of FailedPrecondition.
     */
    Code[Code["OutOfRange"] = 11] = "OutOfRange";
    /**
     * Operation not implemented or disabled.
     */
    Code[Code["Unimplemented"] = 12] = "Unimplemented";
    /**
     * Internal error, reserved for "serious errors".
     */
    Code[Code["Internal"] = 13] = "Internal";
    /**
     * Unavailable, client should back off and retry.
     */
    Code[Code["Unavailable"] = 14] = "Unavailable";
    /**
     * Unrecoverable data loss or corruption.
     */
    Code[Code["DataLoss"] = 15] = "DataLoss";
    /**
     * Request isn't authenticated.
     */
    Code[Code["Unauthenticated"] = 16] = "Unauthenticated";
})(Code || (Code = {}));


/***/ }),
/* 6 */
/***/ ((__unused_webpack___webpack_module__, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   ConnectError: () => (/* binding */ ConnectError)
/* harmony export */ });
/* harmony import */ var _code_js__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(5);
/* harmony import */ var _protocol_connect_code_string_js__WEBPACK_IMPORTED_MODULE_1__ = __webpack_require__(7);
// Copyright 2021-2024 The Connect Authors
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//      http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.


/**
 * ConnectError captures four pieces of information: a Code, an error
 * message, an optional cause of the error, and an optional collection of
 * arbitrary Protobuf messages called  "details".
 *
 * Because developer tools typically show just the error message, we prefix
 * it with the status code, so that the most important information is always
 * visible immediately.
 *
 * Error details are wrapped with google.protobuf.Any on the wire, so that
 * a server or middleware can attach arbitrary data to an error. Use the
 * method findDetails() to retrieve the details.
 */
class ConnectError extends Error {
    /**
     * Create a new ConnectError.
     * If no code is provided, code "unknown" is used.
     * Outgoing details are only relevant for the server side - a service may
     * raise an error with details, and it is up to the protocol implementation
     * to encode and send the details along with error.
     */
    constructor(message, code = _code_js__WEBPACK_IMPORTED_MODULE_0__.Code.Unknown, metadata, outgoingDetails, cause) {
        super(createMessage(message, code));
        this.name = "ConnectError";
        // see https://www.typescriptlang.org/docs/handbook/release-notes/typescript-2-2.html#example
        Object.setPrototypeOf(this, new.target.prototype);
        this.rawMessage = message;
        this.code = code;
        this.metadata = new Headers(metadata !== null && metadata !== void 0 ? metadata : {});
        this.details = outgoingDetails !== null && outgoingDetails !== void 0 ? outgoingDetails : [];
        this.cause = cause;
    }
    /**
     * Convert any value - typically a caught error into a ConnectError,
     * following these rules:
     * - If the value is already a ConnectError, return it as is.
     * - If the value is an AbortError from the fetch API, return the message
     *   of the AbortError with code Canceled.
     * - For other Errors, return the error message with code Unknown by default.
     * - For other values, return the values String representation as a message,
     *   with the code Unknown by default.
     * The original value will be used for the "cause" property for the new
     * ConnectError.
     */
    static from(reason, code = _code_js__WEBPACK_IMPORTED_MODULE_0__.Code.Unknown) {
        if (reason instanceof ConnectError) {
            return reason;
        }
        if (reason instanceof Error) {
            if (reason.name == "AbortError") {
                // Fetch requests can only be canceled with an AbortController.
                // We detect that condition by looking at the name of the raised
                // error object, and translate to the appropriate status code.
                return new ConnectError(reason.message, _code_js__WEBPACK_IMPORTED_MODULE_0__.Code.Canceled);
            }
            return new ConnectError(reason.message, code, undefined, undefined, reason);
        }
        return new ConnectError(String(reason), code, undefined, undefined, reason);
    }
    static [Symbol.hasInstance](v) {
        if (!(v instanceof Error)) {
            return false;
        }
        if (Object.getPrototypeOf(v) === ConnectError.prototype) {
            return true;
        }
        return (v.name === "ConnectError" &&
            "code" in v &&
            typeof v.code === "number" &&
            "metadata" in v &&
            "details" in v &&
            Array.isArray(v.details) &&
            "rawMessage" in v &&
            typeof v.rawMessage == "string" &&
            "cause" in v);
    }
    findDetails(typeOrRegistry) {
        const registry = "typeName" in typeOrRegistry
            ? {
                findMessage: (typeName) => typeName === typeOrRegistry.typeName ? typeOrRegistry : undefined,
            }
            : typeOrRegistry;
        const details = [];
        for (const data of this.details) {
            if ("getType" in data) {
                if (registry.findMessage(data.getType().typeName)) {
                    details.push(data);
                }
                continue;
            }
            const type = registry.findMessage(data.type);
            if (type) {
                try {
                    details.push(type.fromBinary(data.value));
                }
                catch (_) {
                    // We silently give up if we are unable to parse the detail, because
                    // that appears to be the least worst behavior.
                    // It is very unlikely that a user surrounds a catch body handling the
                    // error with another try-catch statement, and we do not want to
                    // recommend doing so.
                }
            }
        }
        return details;
    }
}
/**
 * Create an error message, prefixing the given code.
 */
function createMessage(message, code) {
    return message.length
        ? `[${(0,_protocol_connect_code_string_js__WEBPACK_IMPORTED_MODULE_1__.codeToString)(code)}] ${message}`
        : `[${(0,_protocol_connect_code_string_js__WEBPACK_IMPORTED_MODULE_1__.codeToString)(code)}]`;
}


/***/ }),
/* 7 */
/***/ ((__unused_webpack___webpack_module__, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   codeFromString: () => (/* binding */ codeFromString),
/* harmony export */   codeToString: () => (/* binding */ codeToString)
/* harmony export */ });
/* harmony import */ var _code_js__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(5);
// Copyright 2021-2024 The Connect Authors
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//      http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

/**
 * codeToString returns the string representation of a Code.
 *
 * @private Internal code, does not follow semantic versioning.
 */
function codeToString(value) {
    const name = _code_js__WEBPACK_IMPORTED_MODULE_0__.Code[value];
    if (typeof name != "string") {
        return value.toString();
    }
    return (name[0].toLowerCase() +
        name.substring(1).replace(/[A-Z]/g, (c) => "_" + c.toLowerCase()));
}
let stringToCode;
/**
 * codeFromString parses the string representation of a Code in snake_case.
 * For example, the string "permission_denied" parses into Code.PermissionDenied.
 *
 * If the given string cannot be parsed, the function returns undefined.
 *
 * @private Internal code, does not follow semantic versioning.
 */
function codeFromString(value) {
    if (!stringToCode) {
        stringToCode = {};
        for (const value of Object.values(_code_js__WEBPACK_IMPORTED_MODULE_0__.Code)) {
            if (typeof value == "string") {
                continue;
            }
            stringToCode[codeToString(value)] = value;
        }
    }
    return stringToCode[value];
}


/***/ })
/******/ 	]);
/************************************************************************/
/******/ 	// The module cache
/******/ 	var __webpack_module_cache__ = {};
/******/ 	
/******/ 	// The require function
/******/ 	function __webpack_require__(moduleId) {
/******/ 		// Check if module is in cache
/******/ 		var cachedModule = __webpack_module_cache__[moduleId];
/******/ 		if (cachedModule !== undefined) {
/******/ 			return cachedModule.exports;
/******/ 		}
/******/ 		// Create a new module (and put it into the cache)
/******/ 		var module = __webpack_module_cache__[moduleId] = {
/******/ 			// no module.id needed
/******/ 			// no module.loaded needed
/******/ 			exports: {}
/******/ 		};
/******/ 	
/******/ 		// Execute the module function
/******/ 		__webpack_modules__[moduleId](module, module.exports, __webpack_require__);
/******/ 	
/******/ 		// Return the exports of the module
/******/ 		return module.exports;
/******/ 	}
/******/ 	
/************************************************************************/
/******/ 	/* webpack/runtime/compat get default export */
/******/ 	(() => {
/******/ 		// getDefaultExport function for compatibility with non-harmony modules
/******/ 		__webpack_require__.n = (module) => {
/******/ 			var getter = module && module.__esModule ?
/******/ 				() => (module['default']) :
/******/ 				() => (module);
/******/ 			__webpack_require__.d(getter, { a: getter });
/******/ 			return getter;
/******/ 		};
/******/ 	})();
/******/ 	
/******/ 	/* webpack/runtime/define property getters */
/******/ 	(() => {
/******/ 		// define getter functions for harmony exports
/******/ 		__webpack_require__.d = (exports, definition) => {
/******/ 			for(var key in definition) {
/******/ 				if(__webpack_require__.o(definition, key) && !__webpack_require__.o(exports, key)) {
/******/ 					Object.defineProperty(exports, key, { enumerable: true, get: definition[key] });
/******/ 				}
/******/ 			}
/******/ 		};
/******/ 	})();
/******/ 	
/******/ 	/* webpack/runtime/hasOwnProperty shorthand */
/******/ 	(() => {
/******/ 		__webpack_require__.o = (obj, prop) => (Object.prototype.hasOwnProperty.call(obj, prop))
/******/ 	})();
/******/ 	
/******/ 	/* webpack/runtime/make namespace object */
/******/ 	(() => {
/******/ 		// define __esModule on exports
/******/ 		__webpack_require__.r = (exports) => {
/******/ 			if(typeof Symbol !== 'undefined' && Symbol.toStringTag) {
/******/ 				Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });
/******/ 			}
/******/ 			Object.defineProperty(exports, '__esModule', { value: true });
/******/ 		};
/******/ 	})();
/******/ 	
/************************************************************************/
var __webpack_exports__ = {};
// This entry needs to be wrapped in an IIFE because it needs to be isolated against other modules in the chunk.
(() => {
__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   activate: () => (/* binding */ activate),
/* harmony export */   deactivate: () => (/* binding */ deactivate)
/* harmony export */ });
/* harmony import */ var vscode__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(1);
/* harmony import */ var vscode__WEBPACK_IMPORTED_MODULE_0___default = /*#__PURE__*/__webpack_require__.n(vscode__WEBPACK_IMPORTED_MODULE_0__);
/* harmony import */ var _backgroundComposerRemoteAuthorityResolver_js__WEBPACK_IMPORTED_MODULE_1__ = __webpack_require__(2);


function activate(context) {
  const outputChannel = vscode__WEBPACK_IMPORTED_MODULE_0__.window.createOutputChannel("Cursor Resolver");
  context.subscriptions.push(outputChannel);
  const isNode = typeof process !== "undefined" && !!process.versions?.node;
  outputChannel.appendLine(`[cursor-resolver] Running in ${isNode ? "Node.js" : "web-worker"} extension host`);
  const remoteAuthorityResolver = new _backgroundComposerRemoteAuthorityResolver_js__WEBPACK_IMPORTED_MODULE_1__.BackgroundComposerAuthorityResolver(
    vscode__WEBPACK_IMPORTED_MODULE_0__.cursor.connectionTokenProvider,
    outputChannel
  );
  context.subscriptions.push(
    vscode__WEBPACK_IMPORTED_MODULE_0__.workspace.registerRemoteAuthorityResolver(
      "background-composer",
      remoteAuthorityResolver
    )
  );
}
function deactivate() {
}

})();

var __webpack_export_target__ = exports;
for(var __webpack_i__ in __webpack_exports__) __webpack_export_target__[__webpack_i__] = __webpack_exports__[__webpack_i__];
if(__webpack_exports__.__esModule) Object.defineProperty(__webpack_export_target__, "__esModule", { value: true });
/******/ })()
;
//# sourceMappingURL=main.js.map