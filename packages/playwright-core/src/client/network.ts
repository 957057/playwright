/**
 * Copyright (c) Microsoft Corporation.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { ChannelOwner } from './channelOwner';
import { isTargetClosedError } from './errors';
import { Events } from './events';
import { APIResponse } from './fetch';
import { Frame } from './frame';
import { Waiter } from './waiter';
import { Worker } from './worker';
import { assert } from '../utils/isomorphic/assert';
import { headersObjectToArray } from '../utils/isomorphic/headers';
import { urlMatches } from '../utils/isomorphic/urlMatch';
import { LongStandingScope, ManualPromise } from '../utils/isomorphic/manualPromise';
import { MultiMap } from '../utils/isomorphic/multimap';
import { isRegExp, isString } from '../utils/isomorphic/rtti';
import { rewriteErrorMessage } from '../utils/isomorphic/stackTrace';
import { getMimeTypeForPath } from '../utils/isomorphic/mimeType';

import type { BrowserContext } from './browserContext';
import type { Page } from './page';
import type { Headers, RemoteAddr, SecurityDetails, WaitForEventOptions } from './types';
import type { Serializable } from '../../types/structs';
import type * as api from '../../types/types';
import type { HeadersArray } from '../utils/isomorphic/types';
import type { URLMatch } from '../utils/isomorphic/urlMatch';
import type * as channels from '@protocol/channels';
import type { Platform, Zone } from './platform';

export type NetworkCookie = {
  name: string,
  value: string,
  domain: string,
  path: string,
  expires: number,
  httpOnly: boolean,
  secure: boolean,
  sameSite: 'Strict' | 'Lax' | 'None'
};

export type SetNetworkCookieParam = {
  name: string,
  value: string,
  url?: string,
  domain?: string,
  path?: string,
  expires?: number,
  httpOnly?: boolean,
  secure?: boolean,
  sameSite?: 'Strict' | 'Lax' | 'None'
};

export type ClearNetworkCookieOptions = {
  name?: string | RegExp,
  domain?: string | RegExp,
  path?: string | RegExp,
};

type SerializedFallbackOverrides = {
  url?: string;
  method?: string;
  headers?: Headers;
  postDataBuffer?: Buffer;
};

type FallbackOverrides = {
  url?: string;
  method?: string;
  headers?: Headers;
  postData?: string | Buffer | Serializable;
};

export class Request extends ChannelOwner<channels.RequestChannel> implements api.Request {
  private _redirectedFrom: Request | null = null;
  private _redirectedTo: Request | null = null;
  _failureText: string | null = null;
  private _provisionalHeaders: RawHeaders;
  private _actualHeadersPromise: Promise<RawHeaders> | undefined;
  _timing: ResourceTiming;
  private _fallbackOverrides: SerializedFallbackOverrides = {};

  static from(request: channels.RequestChannel): Request {
    return (request as any)._object;
  }

  static fromNullable(request: channels.RequestChannel | undefined): Request | null {
    return request ? Request.from(request) : null;
  }

  constructor(parent: ChannelOwner, type: string, guid: string, initializer: channels.RequestInitializer) {
    super(parent, type, guid, initializer);
    this._redirectedFrom = Request.fromNullable(initializer.redirectedFrom);
    if (this._redirectedFrom)
      this._redirectedFrom._redirectedTo = this;
    this._provisionalHeaders = new RawHeaders(initializer.headers);
    this._timing = {
      startTime: 0,
      domainLookupStart: -1,
      domainLookupEnd: -1,
      connectStart: -1,
      secureConnectionStart: -1,
      connectEnd: -1,
      requestStart: -1,
      responseStart: -1,
      responseEnd: -1,
    };
  }

  url(): string {
    return this._fallbackOverrides.url || this._initializer.url;
  }

  resourceType(): string {
    return this._initializer.resourceType;
  }

  method(): string {
    return this._fallbackOverrides.method || this._initializer.method;
  }

  postData(): string | null {
    return (this._fallbackOverrides.postDataBuffer || this._initializer.postData)?.toString('utf-8') || null;
  }

  postDataBuffer(): Buffer | null {
    return this._fallbackOverrides.postDataBuffer || this._initializer.postData || null;
  }

  postDataJSON(): Object | null {
    const postData = this.postData();
    if (!postData)
      return null;

    const contentType = this.headers()['content-type'];
    if (contentType?.includes('application/x-www-form-urlencoded')) {
      const entries: Record<string, string> = {};
      const parsed = new URLSearchParams(postData);
      for (const [k, v] of parsed.entries())
        entries[k] = v;
      return entries;
    }

    try {
      return JSON.parse(postData);
    } catch (e) {
      throw new Error('POST data is not a valid JSON object: ' + postData);
    }
  }

  /**
   * @deprecated
   */
  headers(): Headers {
    if (this._fallbackOverrides.headers)
      return RawHeaders._fromHeadersObjectLossy(this._fallbackOverrides.headers).headers();
    return this._provisionalHeaders.headers();
  }

  async _actualHeaders(): Promise<RawHeaders> {
    if (this._fallbackOverrides.headers)
      return RawHeaders._fromHeadersObjectLossy(this._fallbackOverrides.headers);

    if (!this._actualHeadersPromise) {
      this._actualHeadersPromise = this._wrapApiCall(async () => {
        return new RawHeaders((await this._channel.rawRequestHeaders()).headers);
      }, { internal: true });
    }
    return await this._actualHeadersPromise;
  }

  async allHeaders(): Promise<Headers> {
    return (await this._actualHeaders()).headers();
  }

  async headersArray(): Promise<HeadersArray> {
    return (await this._actualHeaders()).headersArray();
  }

  async headerValue(name: string): Promise<string | null> {
    return (await this._actualHeaders()).get(name);
  }

  async response(): Promise<Response | null> {
    return Response.fromNullable((await this._channel.response()).response);
  }

  async _internalResponse(): Promise<Response | null> {
    return Response.fromNullable((await this._channel.response()).response);
  }

  frame(): Frame {
    if (!this._initializer.frame) {
      assert(this.serviceWorker());
      throw new Error('Service Worker requests do not have an associated frame.');
    }
    const frame = Frame.from(this._initializer.frame);
    if (!frame._page) {
      throw new Error([
        'Frame for this navigation request is not available, because the request',
        'was issued before the frame is created. You can check whether the request',
        'is a navigation request by calling isNavigationRequest() method.',
      ].join('\n'));
    }
    return frame;
  }

  _safePage(): Page | null {
    return Frame.fromNullable(this._initializer.frame)?._page || null;
  }

  serviceWorker(): Worker | null {
    return this._initializer.serviceWorker ? Worker.from(this._initializer.serviceWorker) : null;
  }

  isNavigationRequest(): boolean {
    return this._initializer.isNavigationRequest;
  }

  redirectedFrom(): Request | null {
    return this._redirectedFrom;
  }

  redirectedTo(): Request | null {
    return this._redirectedTo;
  }

  failure(): { errorText: string; } | null {
    if (this._failureText === null)
      return null;
    return {
      errorText: this._failureText
    };
  }

  timing(): ResourceTiming {
    return this._timing;
  }

  async sizes(): Promise<RequestSizes> {
    const response = await this.response();
    if (!response)
      throw new Error('Unable to fetch sizes for failed request');
    return (await response._channel.sizes()).sizes;
  }

  _setResponseEndTiming(responseEndTiming: number) {
    this._timing.responseEnd = responseEndTiming;
    if (this._timing.responseStart === -1)
      this._timing.responseStart = responseEndTiming;
  }

  _finalRequest(): Request {
    return this._redirectedTo ? this._redirectedTo._finalRequest() : this;
  }

  _applyFallbackOverrides(overrides: FallbackOverrides) {
    if (overrides.url)
      this._fallbackOverrides.url = overrides.url;
    if (overrides.method)
      this._fallbackOverrides.method = overrides.method;
    if (overrides.headers)
      this._fallbackOverrides.headers = overrides.headers;

    if (isString(overrides.postData))
      this._fallbackOverrides.postDataBuffer = Buffer.from(overrides.postData, 'utf-8');
    else if (overrides.postData instanceof Buffer)
      this._fallbackOverrides.postDataBuffer = overrides.postData;
    else if (overrides.postData)
      this._fallbackOverrides.postDataBuffer = Buffer.from(JSON.stringify(overrides.postData), 'utf-8');
  }

  _fallbackOverridesForContinue() {
    return this._fallbackOverrides;
  }

  _targetClosedScope(): LongStandingScope {
    return this.serviceWorker()?._closedScope || this._safePage()?._closedOrCrashedScope || new LongStandingScope();
  }
}

export class Route extends ChannelOwner<channels.RouteChannel> implements api.Route {
  private _handlingPromise: ManualPromise<boolean> | null = null;
  _context!: BrowserContext;
  _didThrow: boolean = false;

  static from(route: channels.RouteChannel): Route {
    return (route as any)._object;
  }

  constructor(parent: ChannelOwner, type: string, guid: string, initializer: channels.RouteInitializer) {
    super(parent, type, guid, initializer);
  }

  request(): Request {
    return Request.from(this._initializer.request);
  }

  private async _raceWithTargetClose(promise: Promise<any>): Promise<void> {
    // When page closes or crashes, we catch any potential rejects from this Route.
    // Note that page could be missing when routing popup's initial request that
    // does not have a Page initialized just yet.
    return await this.request()._targetClosedScope().safeRace(promise);
  }

  async _startHandling(): Promise<boolean> {
    this._handlingPromise = new ManualPromise();
    return await this._handlingPromise;
  }

  async fallback(options: FallbackOverrides = {}) {
    this._checkNotHandled();
    this.request()._applyFallbackOverrides(options);
    this._reportHandled(false);
  }

  async abort(errorCode?: string) {
    await this._handleRoute(async () => {
      await this._raceWithTargetClose(this._channel.abort({ errorCode }));
    });
  }

  async _redirectNavigationRequest(url: string) {
    await this._handleRoute(async () => {
      await this._raceWithTargetClose(this._channel.redirectNavigationRequest({ url }));
    });
  }

  async fetch(options: FallbackOverrides & { maxRedirects?: number, maxRetries?: number, timeout?: number } = {}): Promise<APIResponse> {
    return await this._wrapApiCall(async () => {
      return await this._context.request._innerFetch({ request: this.request(), data: options.postData, ...options });
    });
  }

  async fulfill(options: { response?: api.APIResponse, status?: number, headers?: Headers, contentType?: string, body?: string | Buffer, json?: any, path?: string } = {}) {
    await this._handleRoute(async () => {
      await this._innerFulfill(options);
    });
  }

  private async _handleRoute(callback: () => Promise<void>) {
    this._checkNotHandled();
    try {
      await callback();
      this._reportHandled(true);
    } catch (e) {
      this._didThrow = true;
      throw e;
    }
  }

  private async _innerFulfill(options: { response?: api.APIResponse, status?: number, headers?: Headers, contentType?: string, body?: string | Buffer, json?: any, path?: string } = {}): Promise<void> {
    let fetchResponseUid;
    let { status: statusOption, headers: headersOption, body } = options;

    if (options.json !== undefined) {
      assert(options.body === undefined, 'Can specify either body or json parameters');
      body = JSON.stringify(options.json);
    }

    if (options.response instanceof APIResponse) {
      statusOption ??= options.response.status();
      headersOption ??= options.response.headers();
      if (body === undefined && options.path === undefined) {
        if (options.response._request._connection === this._connection)
          fetchResponseUid = (options.response as APIResponse)._fetchUid();
        else
          body = await options.response.body();
      }
    }

    let isBase64 = false;
    let length = 0;
    if (options.path) {
      const buffer = await this._platform.fs().promises.readFile(options.path);
      body = buffer.toString('base64');
      isBase64 = true;
      length = buffer.length;
    } else if (isString(body)) {
      isBase64 = false;
      length = Buffer.byteLength(body);
    } else if (body) {
      length = body.length;
      body = body.toString('base64');
      isBase64 = true;
    }

    const headers: Headers = {};
    for (const header of Object.keys(headersOption || {}))
      headers[header.toLowerCase()] = String(headersOption![header]);
    if (options.contentType)
      headers['content-type'] = String(options.contentType);
    else if (options.json)
      headers['content-type'] = 'application/json';
    else if (options.path)
      headers['content-type'] = getMimeTypeForPath(options.path) || 'application/octet-stream';
    if (length && !('content-length' in headers))
      headers['content-length'] = String(length);

    await this._raceWithTargetClose(this._channel.fulfill({
      status: statusOption || 200,
      headers: headersObjectToArray(headers),
      body,
      isBase64,
      fetchResponseUid
    }));
  }

  async continue(options: FallbackOverrides = {}) {
    await this._handleRoute(async () => {
      this.request()._applyFallbackOverrides(options);
      await this._innerContinue(false /* isFallback */);
    });
  }

  _checkNotHandled() {
    if (!this._handlingPromise)
      throw new Error('Route is already handled!');
  }

  _reportHandled(done: boolean) {
    const chain = this._handlingPromise!;
    this._handlingPromise = null;
    chain.resolve(done);
  }

  async _innerContinue(isFallback: boolean) {
    const options = this.request()._fallbackOverridesForContinue();
    return await this._raceWithTargetClose(this._channel.continue({
      url: options.url,
      method: options.method,
      headers: options.headers ? headersObjectToArray(options.headers) : undefined,
      postData: options.postDataBuffer,
      isFallback,
    }));
  }
}

export class WebSocketRoute extends ChannelOwner<channels.WebSocketRouteChannel> implements api.WebSocketRoute {
  static from(route: channels.WebSocketRouteChannel): WebSocketRoute {
    return (route as any)._object;
  }

  private _onPageMessage?: (message: string | Buffer) => any;
  private _onPageClose?: (code: number | undefined, reason: string | undefined) => any;
  private _onServerMessage?: (message: string | Buffer) => any;
  private _onServerClose?: (code: number | undefined, reason: string | undefined) => any;
  private _server: api.WebSocketRoute;
  private _connected = false;

  constructor(parent: ChannelOwner, type: string, guid: string, initializer: channels.WebSocketRouteInitializer) {
    super(parent, type, guid, initializer);

    this._server = {
      onMessage: (handler: (message: string | Buffer) => any) => {
        this._onServerMessage = handler;
      },

      onClose: (handler: (code: number | undefined, reason: string | undefined) => any) => {
        this._onServerClose = handler;
      },

      connectToServer: () => {
        throw new Error(`connectToServer must be called on the page-side WebSocketRoute`);
      },

      url: () => {
        return this._initializer.url;
      },

      close: async (options: { code?: number, reason?: string } = {}) => {
        await this._channel.closeServer({ ...options, wasClean: true }).catch(() => {});
      },

      send: (message: string | Buffer) => {
        if (isString(message))
          this._channel.sendToServer({ message, isBase64: false }).catch(() => {});
        else
          this._channel.sendToServer({ message: message.toString('base64'), isBase64: true }).catch(() => {});
      },

      async [Symbol.asyncDispose]() {
        await this.close();
      },
    };

    this._channel.on('messageFromPage', ({ message, isBase64 }) => {
      if (this._onPageMessage)
        this._onPageMessage(isBase64 ? Buffer.from(message, 'base64') : message);
      else if (this._connected)
        this._channel.sendToServer({ message, isBase64 }).catch(() => {});
    });

    this._channel.on('messageFromServer', ({ message, isBase64 }) => {
      if (this._onServerMessage)
        this._onServerMessage(isBase64 ? Buffer.from(message, 'base64') : message);
      else
        this._channel.sendToPage({ message, isBase64 }).catch(() => {});
    });

    this._channel.on('closePage', ({ code, reason, wasClean }) => {
      if (this._onPageClose)
        this._onPageClose(code, reason);
      else
        this._channel.closeServer({ code, reason, wasClean }).catch(() => {});
    });

    this._channel.on('closeServer', ({ code, reason, wasClean }) => {
      if (this._onServerClose)
        this._onServerClose(code, reason);
      else
        this._channel.closePage({ code, reason, wasClean }).catch(() => {});
    });
  }

  url() {
    return this._initializer.url;
  }

  async close(options: { code?: number, reason?: string } = {}) {
    await this._channel.closePage({ ...options, wasClean: true }).catch(() => {});
  }

  connectToServer() {
    if (this._connected)
      throw new Error('Already connected to the server');
    this._connected = true;
    this._channel.connect().catch(() => {});
    return this._server;
  }

  send(message: string | Buffer) {
    if (isString(message))
      this._channel.sendToPage({ message, isBase64: false }).catch(() => {});
    else
      this._channel.sendToPage({ message: message.toString('base64'), isBase64: true }).catch(() => {});
  }

  onMessage(handler: (message: string | Buffer) => any) {
    this._onPageMessage = handler;
  }

  onClose(handler: (code: number | undefined, reason: string | undefined) => any) {
    this._onPageClose = handler;
  }

  async [Symbol.asyncDispose]() {
    await this.close();
  }

  async _afterHandle() {
    if (this._connected)
      return;
    // Ensure that websocket is "open" and can send messages without an actual server connection.
    // If this happens after the page has been closed, ignore the error.
    await this._channel.ensureOpened().catch(() => {});
  }
}

export class WebSocketRouteHandler {
  private readonly _baseURL: string | undefined;
  readonly url: URLMatch;
  readonly handler: WebSocketRouteHandlerCallback;

  constructor(baseURL: string | undefined, url: URLMatch, handler: WebSocketRouteHandlerCallback) {
    this._baseURL = baseURL;
    this.url = url;
    this.handler = handler;
  }

  static prepareInterceptionPatterns(handlers: WebSocketRouteHandler[]) {
    const patterns: channels.BrowserContextSetWebSocketInterceptionPatternsParams['patterns'] = [];
    let all = false;
    for (const handler of handlers) {
      if (isString(handler.url))
        patterns.push({ glob: handler.url });
      else if (isRegExp(handler.url))
        patterns.push({ regexSource: handler.url.source, regexFlags: handler.url.flags });
      else
        all = true;
    }
    if (all)
      return [{ glob: '**/*' }];
    return patterns;
  }

  public matches(wsURL: string): boolean {
    return urlMatches(this._baseURL, wsURL, this.url, true);
  }

  public async handle(webSocketRoute: WebSocketRoute) {
    const handler = this.handler;
    await handler(webSocketRoute);
    await webSocketRoute._afterHandle();
  }
}

export type RouteHandlerCallback = (route: Route, request: Request) => Promise<any> | void;
export type WebSocketRouteHandlerCallback = (ws: WebSocketRoute) => Promise<any> | void;

export type ResourceTiming = {
  startTime: number;
  domainLookupStart: number;
  domainLookupEnd: number;
  connectStart: number;
  secureConnectionStart: number;
  connectEnd: number;
  requestStart: number;
  responseStart: number;
  responseEnd: number;
};

export type RequestSizes = {
  requestBodySize: number;
  requestHeadersSize: number;
  responseBodySize: number;
  responseHeadersSize: number;
};

export class Response extends ChannelOwner<channels.ResponseChannel> implements api.Response {
  private _provisionalHeaders: RawHeaders;
  private _actualHeadersPromise: Promise<RawHeaders> | undefined;
  private _request: Request;
  readonly _finishedPromise = new ManualPromise<null>();

  static from(response: channels.ResponseChannel): Response {
    return (response as any)._object;
  }

  static fromNullable(response: channels.ResponseChannel | undefined): Response | null {
    return response ? Response.from(response) : null;
  }

  constructor(parent: ChannelOwner, type: string, guid: string, initializer: channels.ResponseInitializer) {
    super(parent, type, guid, initializer);
    this._provisionalHeaders = new RawHeaders(initializer.headers);
    this._request = Request.from(this._initializer.request);
    Object.assign(this._request._timing, this._initializer.timing);
  }

  url(): string {
    return this._initializer.url;
  }

  ok(): boolean {
    // Status 0 is for file:// URLs
    return this._initializer.status === 0 || (this._initializer.status >= 200 && this._initializer.status <= 299);
  }

  status(): number {
    return this._initializer.status;
  }

  statusText(): string {
    return this._initializer.statusText;
  }

  fromServiceWorker(): boolean {
    return this._initializer.fromServiceWorker;
  }

  /**
   * @deprecated
   */
  headers(): Headers {
    return this._provisionalHeaders.headers();
  }

  async _actualHeaders(): Promise<RawHeaders> {
    if (!this._actualHeadersPromise) {
      this._actualHeadersPromise = (async () => {
        return new RawHeaders((await this._channel.rawResponseHeaders()).headers);
      })();
    }
    return await this._actualHeadersPromise;
  }

  async allHeaders(): Promise<Headers> {
    return (await this._actualHeaders()).headers();
  }

  async headersArray(): Promise<HeadersArray> {
    return (await this._actualHeaders()).headersArray().slice();
  }

  async headerValue(name: string): Promise<string | null> {
    return (await this._actualHeaders()).get(name);
  }

  async headerValues(name: string): Promise<string[]> {
    return (await this._actualHeaders()).getAll(name);
  }

  async finished(): Promise<null> {
    return await this.request()._targetClosedScope().race(this._finishedPromise);
  }

  async body(): Promise<Buffer> {
    return (await this._channel.body()).binary;
  }

  async text(): Promise<string> {
    const content = await this.body();
    return content.toString('utf8');
  }

  async json(): Promise<object> {
    const content = await this.text();
    return JSON.parse(content);
  }

  request(): Request {
    return this._request;
  }

  frame(): Frame {
    return this._request.frame();
  }

  async serverAddr(): Promise<RemoteAddr|null> {
    return (await this._channel.serverAddr()).value || null;
  }

  async securityDetails(): Promise<SecurityDetails|null> {
    return (await this._channel.securityDetails()).value || null;
  }
}

export class WebSocket extends ChannelOwner<channels.WebSocketChannel> implements api.WebSocket {
  private _page: Page;
  private _isClosed: boolean;

  static from(webSocket: channels.WebSocketChannel): WebSocket {
    return (webSocket as any)._object;
  }

  constructor(parent: ChannelOwner, type: string, guid: string, initializer: channels.WebSocketInitializer) {
    super(parent, type, guid, initializer);
    this._isClosed = false;
    this._page = parent as Page;
    this._channel.on('frameSent', event => {
      if (event.opcode === 1)
        this.emit(Events.WebSocket.FrameSent, { payload: event.data });
      else if (event.opcode === 2)
        this.emit(Events.WebSocket.FrameSent, { payload: Buffer.from(event.data, 'base64') });
    });
    this._channel.on('frameReceived', event => {
      if (event.opcode === 1)
        this.emit(Events.WebSocket.FrameReceived, { payload: event.data });
      else if (event.opcode === 2)
        this.emit(Events.WebSocket.FrameReceived, { payload: Buffer.from(event.data, 'base64') });
    });
    this._channel.on('socketError', ({ error }) => this.emit(Events.WebSocket.Error, error));
    this._channel.on('close', () => {
      this._isClosed = true;
      this.emit(Events.WebSocket.Close, this);
    });
  }

  url(): string {
    return this._initializer.url;
  }

  isClosed(): boolean {
    return this._isClosed;
  }

  async waitForEvent(event: string, optionsOrPredicate: WaitForEventOptions = {}): Promise<any> {
    return await this._wrapApiCall(async () => {
      const timeout = this._page._timeoutSettings.timeout(typeof optionsOrPredicate === 'function' ? {} : optionsOrPredicate);
      const predicate = typeof optionsOrPredicate === 'function' ? optionsOrPredicate : optionsOrPredicate.predicate;
      const waiter = Waiter.createForEvent(this, event);
      waiter.rejectOnTimeout(timeout, `Timeout ${timeout}ms exceeded while waiting for event "${event}"`);
      if (event !== Events.WebSocket.Error)
        waiter.rejectOnEvent(this, Events.WebSocket.Error, new Error('Socket error'));
      if (event !== Events.WebSocket.Close)
        waiter.rejectOnEvent(this, Events.WebSocket.Close, new Error('Socket closed'));
      waiter.rejectOnEvent(this._page, Events.Page.Close, () => this._page._closeErrorWithReason());
      const result = await waiter.waitForEvent(this, event, predicate as any);
      waiter.dispose();
      return result;
    });
  }
}

export function validateHeaders(headers: Headers) {
  for (const key of Object.keys(headers)) {
    const value = headers[key];
    if (!Object.is(value, undefined) && !isString(value))
      throw new Error(`Expected value of header "${key}" to be String, but "${typeof value}" is found.`);
  }
}

export class RouteHandler {
  private handledCount = 0;
  private readonly _baseURL: string | undefined;
  private readonly _times: number;
  readonly url: URLMatch;
  readonly handler: RouteHandlerCallback;
  private _ignoreException: boolean = false;
  private _activeInvocations: Set<{ complete: Promise<void>, route: Route }> = new Set();
  private _savedZone: Zone;

  constructor(platform: Platform, baseURL: string | undefined, url: URLMatch, handler: RouteHandlerCallback, times: number = Number.MAX_SAFE_INTEGER) {
    this._baseURL = baseURL;
    this._times = times;
    this.url = url;
    this.handler = handler;
    this._savedZone = platform.zones.current().pop();
  }

  static prepareInterceptionPatterns(handlers: RouteHandler[]) {
    const patterns: channels.BrowserContextSetNetworkInterceptionPatternsParams['patterns'] = [];
    let all = false;
    for (const handler of handlers) {
      if (isString(handler.url))
        patterns.push({ glob: handler.url });
      else if (isRegExp(handler.url))
        patterns.push({ regexSource: handler.url.source, regexFlags: handler.url.flags });
      else
        all = true;
    }
    if (all)
      return [{ glob: '**/*' }];
    return patterns;
  }

  public matches(requestURL: string): boolean {
    return urlMatches(this._baseURL, requestURL, this.url);
  }

  public async handle(route: Route): Promise<boolean> {
    return await this._savedZone.run(async () => this._handleImpl(route));
  }

  private async _handleImpl(route: Route): Promise<boolean> {
    const handlerInvocation = { complete: new ManualPromise(), route } ;
    this._activeInvocations.add(handlerInvocation);
    try {
      return await this._handleInternal(route);
    } catch (e) {
      // If the handler was stopped (without waiting for completion), we ignore all exceptions.
      if (this._ignoreException)
        return false;
      if (isTargetClosedError(e)) {
        // We are failing in the handler because the target close closed.
        // Give user a hint!
        rewriteErrorMessage(e, `"${e.message}" while running route callback.\nConsider awaiting \`await page.unrouteAll({ behavior: 'ignoreErrors' })\`\nbefore the end of the test to ignore remaining routes in flight.`);
      }
      throw e;
    } finally {
      handlerInvocation.complete.resolve();
      this._activeInvocations.delete(handlerInvocation);
    }
  }

  async stop(behavior: 'wait' | 'ignoreErrors') {
    // When a handler is manually unrouted or its page/context is closed we either
    // - wait for the current handler invocations to finish
    // - or do not wait, if the user opted out of it, but swallow all exceptions
    //   that happen after the unroute/close.
    if (behavior === 'ignoreErrors') {
      this._ignoreException = true;
    } else {
      const promises = [];
      for (const activation of this._activeInvocations) {
        if (!activation.route._didThrow)
          promises.push(activation.complete);
      }
      await Promise.all(promises);
    }
  }

  private async _handleInternal(route: Route): Promise<boolean> {
    ++this.handledCount;
    const handledPromise = route._startHandling();
    // Extract handler into a variable to avoid [RouteHandler.handler] in the stack.
    const handler = this.handler;
    const [handled] = await Promise.all([
      handledPromise,
      handler(route, route.request()),
    ]);
    return handled;
  }

  public willExpire(): boolean {
    return this.handledCount + 1 >= this._times;
  }
}

export class RawHeaders {
  private _headersArray: HeadersArray;
  private _headersMap = new MultiMap<string, string>();

  static _fromHeadersObjectLossy(headers: Headers): RawHeaders {
    const headersArray: HeadersArray = Object.entries(headers).map(([name, value]) => ({
      name, value
    })).filter(header => header.value !== undefined);
    return new RawHeaders(headersArray);
  }

  constructor(headers: HeadersArray) {
    this._headersArray = headers;
    for (const header of headers)
      this._headersMap.set(header.name.toLowerCase(), header.value);
  }

  get(name: string): string | null {
    const values = this.getAll(name);
    if (!values || !values.length)
      return null;
    return values.join(name.toLowerCase() === 'set-cookie' ? '\n' : ', ');
  }

  getAll(name: string): string[] {
    return [...this._headersMap.get(name.toLowerCase())];
  }

  headers(): Headers {
    const result: Headers = {};
    for (const name of this._headersMap.keys())
      result[name] = this.get(name)!;
    return result;
  }

  headersArray(): HeadersArray {
    return this._headersArray;
  }
}
