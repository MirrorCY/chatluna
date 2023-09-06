import { ModelRequestParams, ModelRequester } from '@dingyi222666/koishi-plugin-chathub/lib/llm-core/platform/api';
import { AIMessageChunk, ChatGenerationChunk } from 'langchain/schema';
import { createLogger } from '@dingyi222666/koishi-plugin-chathub/lib/utils/logger';
import { request } from "@dingyi222666/koishi-plugin-chathub/lib/utils/request"
import { ChatHubError, ChatHubErrorCode } from '@dingyi222666/koishi-plugin-chathub/lib/utils/error';
import { readableStreamToAsyncIterable } from '@dingyi222666/koishi-plugin-chathub/lib/utils/stream';
import { Context, sleep } from 'koishi';
import { HEADERS, HEADERS_INIT_CONVER, buildChatRequest, randomString, unpackResponse } from './constants';
import { BingClientConfig, BingConversationStyle, ChatResponseMessage, ConversationInfo, ConversationResponse } from './types';
import { Config } from '.';
import { WebSocket } from 'ws';
import { serial } from "./constants"



const logger = createLogger()
const STOP_TOKEN = ["\n\nuser:", "\n\nsystem:"]


export class BingRequester extends ModelRequester {

    private _ua = request.randomUA()

    private _headers: typeof HEADERS & Record<string, string> = { ...HEADERS }

    private _conversationId: string

    private _wsUrl = 'wss://sydney.bing.com/sydney/ChatHub'

    private _createConversationUrl = 'https://edgeservices.bing.com/edgesvc/turing/conversation/create'

    private _currentConversation: ConversationInfo

    private _isThrottled = false

    private _cookie: string

    constructor(private ctx: Context, private _pluginConfig: Config, private _chatConfig: BingClientConfig, private _style: BingConversationStyle) {
        super()

        let cookie = _chatConfig.apiKey.length < 1 ? `_U=${randomString(169)}` : _chatConfig.apiKey

        if (!cookie.includes("_U=")) {
            cookie = `_U=${cookie}`
        }

        if (_pluginConfig.webSocketApiEndPoint.length > 0) {
            this._wsUrl = _pluginConfig.webSocketApiEndPoint
        }

        if (_pluginConfig.createConversationApiEndPoint.length > 0) {
            this._createConversationUrl = _pluginConfig.createConversationApiEndPoint
        }

        this._cookie = cookie
        this._headers.cookie = cookie

        //   this._headers['User-Agent'] = this._ua
    }

    async *completionStream(params: ModelRequestParams): AsyncGenerator<ChatGenerationChunk> {

        if (this._isThrottled == true) {
            this._chatConfig.sydney = false
        }

        await this.init()

        let err: Error | null
        const stream = new TransformStream()

        const iterable = readableStreamToAsyncIterable<string>(stream.readable);

        const writable = stream.writable.getWriter()

        setTimeout(async () => {
            const result = await this._sendMessage(params, writable)

            if (result instanceof Error) {
                err = result
            }
        })

        for await (const chunk of iterable) {
           // logger.debug(`chunk: ${chunk}`)
            if (err) {
                await this.dispose()
                throw err
            }

            if (chunk === "[DONE]") {
                return
            }

            yield new ChatGenerationChunk({
                text: chunk,
                message: new AIMessageChunk(chunk)
            })
        }


        return
    }


    private async _sendMessage(params: ModelRequestParams, writable: WritableStreamDefaultWriter<string>): Promise<Error | string> {
        const ws = request.ws(this._wsUrl, {
            headers: {
                ...HEADERS,
                cookie: this._cookie
            }
        })

        let interval: NodeJS.Timeout

        ws.once('open', () => {
            ws.send(serial({ protocol: "json", version: 1 }));


            interval = setInterval(() => {
                ws.send(serial({ type: 6 }))
                // same message is sent back on/after 2nd time as a pong
            }, 15 * 1000);

        });

        const result = await this._buildPromise(params, ws, writable)


        clearInterval(interval)

        if (!(result instanceof Error)) {
            await writable.write("[DONE]")
            this._currentConversation.invocationId++
        }

        return result
    }

    private _buildPromise(params: ModelRequestParams, ws: WebSocket, writable: WritableStreamDefaultWriter<string>): Promise<Error | string> {
        return new Promise(async (resolve, reject) => {

            let replySoFar = ['']
            let messageCursor = 0
            let stopTokenFound = false;


            const conversationInfo = this._currentConversation
            const message = params.input.pop().content
            const sydney = this._chatConfig.sydney
            const previousMessages = params.input


            const stopToken = '\n\nuser:';


            ws.on("message", async (data) => {

                const events = unpackResponse(data.toString())

                const event = events[0]

                if (event?.item?.throttling?.maxNumUserMessagesInConversation) {
                    conversationInfo.maxNumUserMessagesInConversation = event?.item?.throttling?.maxNumUserMessagesInConversation
                }

                if (JSON.stringify(event) === '{}') {

                    ws.send(serial(buildChatRequest(conversationInfo, message, sydney, previousMessages)))

                    ws.send(serial({ type: 6 }))

                } else if (event.type === 1) {

                    if (stopTokenFound) {
                        return;
                    }

                    const messages = event.arguments[0].messages;
                    const message = messages?.[0] as ChatResponseMessage

                    //logger.debug(`Received message: ${JSON.stringify(message)}`)

                    if (!message || message.author !== 'bot') {
                        logger.debug(`Breaking because message is null or author is not bot: ${JSON.stringify(message)}`)
                        return
                    }

                    if (sydney === true && (message.messageType !== "Suggestion" && message.messageType != null)) {
                        return
                    }

                    if (message.messageType != null && sydney == false) {
                        return
                    }

                    /*if (event?.arguments?.[0]?.throttling?. maxNumUserMessagesInConversation) {
                        maxNumUserMessagesInConversation = event?.arguments?.[0]?.throttling?.maxNumUserMessagesInConversation
                    } */

                    let updatedText = message.adaptiveCards?.[0]?.body?.[0]?.text

                    if (updatedText == null) {
                        updatedText = message.text
                    }

                    if (!updatedText || updatedText === replySoFar[messageCursor]) {
                        return
                    }


                    // get the difference between the current text and the previous text
                    if (replySoFar[messageCursor] &&
                        (
                            updatedText.startsWith(replySoFar[messageCursor])
                        )
                    ) {
                        if (updatedText.trim().endsWith(stopToken)) {
                            // apology = true
                            // remove stop token from updated text
                            replySoFar[messageCursor] = updatedText.replace(stopToken, '').trim()

                            return
                        }
                        replySoFar[messageCursor] = updatedText
                    } else if (replySoFar[messageCursor]) {

                        messageCursor += 1
                        replySoFar.push(updatedText)
                    } else {
                        replySoFar[messageCursor] = replySoFar[messageCursor] + updatedText
                    }

                    // logger.debug(`message: ${JSON.stringify(message)}`)

                    await writable.write(replySoFar.join('\n\n'))

                } else if (event.type === 2) {

                    const messages = event.item.messages as ChatResponseMessage[] | undefined

                    if (!messages) {
                        reject(new Error(event.item.result.error || `Unknown error: ${JSON.stringify(event)}`))
                        return
                    }

                    let eventMessage: ChatResponseMessage

                    for (let i = messages.length - 1; i >= 0; i--) {
                        const message = messages[i]
                        if (message.author === 'bot' && message.messageType == null) {
                            eventMessage = messages[i]
                            break
                        }
                    }

                    const limited = messages.some((message) => message.contentOrigin === 'TurnLimiter')


                    if (limited) {
                        reject(new Error('Sorry, you have reached chat turns limit in this conversation.'))
                        return
                    }

                    if (event.item?.result?.error) {
                        logger.debug(JSON.stringify(event.item))

                        if (replySoFar[0] && eventMessage) {
                            eventMessage.adaptiveCards[0].body[0].text = replySoFar.join('\n\n');
                            eventMessage.text = eventMessage.adaptiveCards[0].body[0].text;

                            resolve(eventMessage.text)
                            return;
                        }

                        resolve(new Error(`${event.item.result.value}: ${event.item.result.message} - ${event}`))

                        return;
                    }

                    if (!eventMessage) {
                        reject(new Error('No message was generated.'));
                        return;
                    }
                    if (eventMessage?.author !== 'bot') {

                        if (!event.item?.result) {
                            reject(Error('Unexpected message author.'))
                            return
                        }

                        if (event.item?.result?.exception?.indexOf('maximum context length') > -1) {
                            reject(new Error('long context with 8k token limit, please start a new conversation'))
                        } else if (event.item?.result.value === 'Throttled') {
                            logger.warn(JSON.stringify(event.item?.result))
                            this._isThrottled = true
                            reject(new Error('The account the SearchRequest was made with has been throttled.'))
                        } else if (eventMessage?.author === 'user') {
                            reject(new Error('The bing is end of the conversation. Try start a new conversation.'))
                        } else {
                            logger.warn(JSON.stringify(event))
                            reject(new Error(`${event.item?.result.value}\n${event.item?.result.error}\n${event.item?.result.exception}`))
                        }

                        return
                    }

                    // 自定义stopToken（如果是上下文续杯的话）
                    // The moderation filter triggered, so just return the text we have so far
                    if ((stopTokenFound || replySoFar[0]) /* || event.item.messages[0].topicChangerText) */ || sydney) {
                        eventMessage.adaptiveCards = eventMessage.adaptiveCards || [];
                        eventMessage.adaptiveCards[0] = eventMessage.adaptiveCards[0] || {
                            type: 'AdaptiveCard',
                            body: [{
                                type: 'TextBlock',
                                wrap: true,
                                text: ""
                            }],
                            version: '1.0'
                        };
                        eventMessage.adaptiveCards[0].body = eventMessage.adaptiveCards[0].body || [];
                        eventMessage.adaptiveCards[0].body[0] = eventMessage.adaptiveCards[0].body[0] || {
                            type: 'TextBlock',
                            wrap: true,
                            text: ""
                        }
                        eventMessage.adaptiveCards[0].body[0].text = (replySoFar.length < 1 || replySoFar[0].length < 1) ? (eventMessage.spokenText ?? eventMessage.text) : replySoFar.join('\n\n');
                        eventMessage.text = eventMessage.adaptiveCards[0].body[0].text
                        // delete useless suggestions from moderation filter
                        delete eventMessage.suggestedResponses;
                    }

                    resolve(eventMessage.requestId)
                    return
                } else if (event.type === 7) {
                    // [{"type":7,"error":"Connection closed with an error.","allowReconnect":true}]
                    ws.close()
                    resolve(new Error("error: " + event.error || 'Connection closed with an error.'));
                    return;
                }

            })


            ws.on('error', err => {
                reject(err)
            });
        })
    }

    async dispose(): Promise<void> {
        this._currentConversation = null
    }


    async init(): Promise<void> {

        if (this._currentConversation == null || this._chatConfig.sydney) {
            const conversationResponse = await this._createConversation()
            this._currentConversation = {
                conversationId: conversationResponse.conversationId,
                invocationId: 0,
                clientId: conversationResponse.clientId,
                conversationSignature: conversationResponse.conversationSignature,
                conversationStyle: this._style
            }
        }
    }

    private async _createConversation(): Promise<ConversationResponse> {
        let resp: ConversationResponse
        try {
            resp = (await (await request.fetch(this._createConversationUrl, {
                headers: {
                    ...HEADERS_INIT_CONVER,
                    cookie: this._cookie
                }, redirect: 'error'
            })).json()) as ConversationResponse

            logger.debug(`Create conversation response: ${JSON.stringify(resp)}`)

            if (!resp.result) {
                throw new Error('Invalid response')
            }
        } catch (err) {
            throw new ChatHubError(ChatHubErrorCode.MODEL_CONVERSION_INIT_ERROR, err)
        }

        if (resp.result.value !== 'Success') {
            logger.debug(`Failed to create conversation: ${JSON.stringify(resp)}`)
            const message = `${resp.result.value}: ${resp.result.message}`
            throw new ChatHubError(ChatHubErrorCode.MODEL_CONVERSION_INIT_ERROR, new Error(message))
        }

        return resp
    }
}