import { BaseMessage, MessageType } from '@langchain/core/messages'
import { OllamaMessage } from './types'

export function langchainMessageToOllamaMessage(
    messages: BaseMessage[]
): OllamaMessage[] {
    const result: OllamaMessage[] = []

    const mappedMessage = messages.map((rawMessage) => {
        return {
            role: messageTypeToOllamaRole(rawMessage._getType()),
            content: rawMessage.content as string
        }
    })

    for (let i = 0; i < mappedMessage.length; i++) {
        const message = mappedMessage[i]

        if (message.role !== 'system') {
            result.push(message)
            continue
        }

        /*   if (removeSystemMessage) {
            continue
        } */

        result.push({
            role: 'user',
            content: message.content
        })

        if (mappedMessage?.[i + 1]?.role === 'assistant') {
            continue
        }

        if (mappedMessage?.[i + 1]?.role === 'user') {
            result.push({
                role: 'assistant',
                content: 'Okay, what do I need to do?'
            })
        }
    }

    if (result[result.length - 1].role === 'model') {
        result.push({
            role: 'user',
            content:
                'Continue what I said to you last message. Follow these instructions.'
        })
    }

    return result
}

export function messageTypeToOllamaRole(type: MessageType): string {
    switch (type) {
        case 'system':
            return 'system'
        case 'ai':
            return 'assistant'
        case 'human':
            return 'user'
        case 'function':
            return 'function'
        default:
            throw new Error(`Unknown message type: ${type}`)
    }
}
