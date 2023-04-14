import { Logger } from 'koishi'
import { ChatMessage } from './types'
import OpenAIAdapter from '.'
import { Conversation, ConversationConfig, InjectData, Message, SimpleMessage, createLogger } from '@dingyi222666/koishi-plugin-chathub'
import { Tiktoken, TiktokenModel, encoding_for_model, get_encoding } from "@dqbd/tiktoken";


const logger = createLogger('@dingyi222666/chathub-openai-adapter/prompt')


export class Prompt {

    private tiktoken: Tiktoken
    static maxTokenLength = 4050

    constructor(
        private readonly config: OpenAIAdapter.Config
    ) { }

    private generatChatMessage(role: 'user' | 'system' | 'model', config: ConversationConfig, message: Message, isCurrentMessage: boolean = false): ChatMessage {
        let content: string

        if ((isCurrentMessage && config.inject != 'none' ||
            !isCurrentMessage && config.inject == 'enhanced') && message.inject) {
            content = `这是对话的内容： ` + `${message.sender} say: ` + message.content
                + `这是从你之前的对话或者从网络上获得的信息，请你参考这些信息基于上面和你对话的内容要求生成回复，如果这些信息和上面对话的内容没有关联时请忽略这些信息：${this.formatInjectData(message.inject)}\n。`
        }
        else {
            content = `${message.sender} say: ` + message.content
        }

        return {
            role: role == 'model' ? 'assistant' : role,
            content: content,
            name: message.sender ?? role
        }
    }

    private formatInjectData(inject: InjectData[]): string {
        const result = []

        inject.forEach((data) => {
            const builder = []

            if (data.title) {
                builder.push("t: " + data.title)
            }

            builder.push("c: " + data.data.trim())

            if (data.source) {
                builder.push("s: " + data.source)
            }

            result.push(builder.join())
        })

        return result.join(' ')
    }

    private calculateTokenLength(message: ChatMessage): number {
        return this.tiktoken.encode(JSON.stringify(message)).length
    }

    generatePrompt(conversation: Conversation, message: Message): ChatMessage[] {
        const result: ChatMessage[] = []
        const initialMessage = conversation.config.initialPrompts
        let currrentChatMessage: ChatMessage
        let currentTokenLength = 0
        let currentMessage = message

        this.tiktoken = this.tiktoken ?? encoding_for_model(<TiktokenModel>this.config.chatModel);


        const initialMessages = []

        // 把人格设定放进去
        if (initialMessage && initialMessage instanceof Array) {
            initialMessage.forEach((msg) => {
                initialMessages.push({
                    role: 'system',
                    content: msg.content,
                    name: msg.sender ?? 'system'
                })
            })
        } else if (initialMessage) {
            initialMessages.push({
                role: 'system',
                content: (<SimpleMessage>initialMessage).content,
                name: (<SimpleMessage>initialMessage).sender ?? 'system'
            })
        }

        for (let i = initialMessages.length - 1; i >= 0; i--) {
            const initialMessage = initialMessages[i]
            const tokenLength = this.calculateTokenLength(initialMessage)
            currentTokenLength += tokenLength
        }

        // 放入当前会话
        const firstChatMessage = this.generatChatMessage('user', conversation.config, currentMessage, true)


        result.unshift(firstChatMessage)

        currentTokenLength += this.calculateTokenLength(firstChatMessage)

        currentMessage = message
        let addToPormptMessageLength = 1
        while (currentTokenLength < Prompt.maxTokenLength) {

            if (currentMessage.parentId == undefined) {
                break
            }

            currentMessage = conversation.messages[currentMessage.parentId]

            currrentChatMessage = this.generatChatMessage(currentMessage.role, conversation.config, currentMessage)

            const tokenLength = this.calculateTokenLength(currrentChatMessage)

            if (currentTokenLength + tokenLength > Prompt.maxTokenLength) {
                // loss some message
                const lostMessageLength = Object.keys(conversation.messages).length - addToPormptMessageLength
                logger.warn(`prompt token length is too long, loss ${lostMessageLength} messages`)
                break
            }

            result.unshift(currrentChatMessage)

            logger.debug(`sub prompt: ${JSON.stringify(currrentChatMessage)}`)

            addToPormptMessageLength++
            currentTokenLength += tokenLength

        }

        result.unshift(...initialMessages)


        logger.debug(`prompt: ${JSON.stringify(result)}`)
        logger.debug(`prompt token length: ${currentTokenLength}`)

        return result
    }

    generatePromptForDavinci(conversation: Conversation, message: Message): string {
        const chatMessages = this.generatePrompt(conversation, message)

        const result = []

        chatMessages.forEach((chatMessage) => {
            const data = {
                role: chatMessage.role,
                content: chatMessage.content,
                name: chatMessage.name
            }
            result.push(JSON.stringify(data))
        })

        //等待补全
        const buffer = []

        buffer.push('[')

        for (const text of result) {
            buffer.push(text)
            buffer.push(',')
        }

        return buffer.join('')

    }

    dispose() {
        this.tiktoken.free()
        this.tiktoken = null
    }

}
