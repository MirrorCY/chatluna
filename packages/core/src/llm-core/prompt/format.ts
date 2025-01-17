import {
    AIMessage,
    BaseMessage,
    HumanMessage,
    SystemMessage
} from '@langchain/core/messages'
import { logger } from 'koishi-plugin-chatluna'
import {
    getTimeDiff,
    rollDice,
    selectFromList
} from 'koishi-plugin-chatluna/utils/string'
import { PresetTemplate } from './type'

type Token = {
    type: 'text' | 'variable' | 'function'
    value: string
    args?: string[]
}

function tokenize(input: string): Token[] {
    const tokens: Token[] = []
    const chars = input.split('')
    const length = chars.length
    let current = 0
    let buffer = ''

    while (current < length) {
        const char = chars[current]

        switch (char) {
            case '{': {
                if (buffer) {
                    tokens.push({ type: 'text', value: buffer })
                    buffer = ''
                }
                current++

                let value = ''
                const args: string[] = []
                let inFunction = false

                while (current < length && chars[current] !== '}') {
                    if (
                        chars[current] === ':' ||
                        chars[current] === '+' ||
                        chars[current] === '-'
                    ) {
                        inFunction = true
                        if (value) {
                            args.push(value)
                            value = ''
                        }
                        // Include '+' or '-' as part of the argument
                        if (chars[current] === '+' || chars[current] === '-') {
                            value += chars[current]
                        }
                    } else if (
                        inFunction &&
                        chars[current] === ':' &&
                        chars[current + 1] === ':'
                    ) {
                        if (value) {
                            args.push(value)
                            value = ''
                        }
                        current++ // Skip the second ':'
                    } else {
                        value += chars[current]
                    }
                    current++
                }

                if (value) {
                    if (inFunction) {
                        args.push(value)
                    } else {
                        tokens.push({ type: 'variable', value })
                    }
                }

                if (inFunction) {
                    tokens.push({
                        type: 'function',
                        value: args.shift() || '',
                        args
                    })
                }
                break
            }
            default:
                buffer += char
        }
        current++
    }

    if (buffer) {
        tokens.push({ type: 'text', value: buffer })
    }

    return tokens
}

export function formatPresetTemplateString(
    rawString: string,
    inputVariables: Record<string, string | (() => string)>,
    variables: string[] = []
): string {
    const tokens = tokenize(rawString)

    return tokens
        .map((token) => {
            switch (token.type) {
                case 'text':
                    return token.value
                case 'variable': {
                    variables.push(token.value)
                    let value = inputVariables[token.value]
                    if (typeof value === 'function') value = value()
                    return value || `{${token.value}}`
                }
                case 'function': {
                    variables.push(token.value)
                    return evaluateFunction(
                        token.value,
                        token.args,
                        inputVariables
                    )
                }
            }
        })
        .join('')
}

function evaluateFunction(
    func: string,
    args: string[],
    inputVariables: Record<string, string | (() => string)>
): string {
    switch (func) {
        case 'time_UTC': {
            const utcOffset = args[0] ? parseInt(args[0]) : 0
            if (isNaN(utcOffset)) {
                logger.warn(`Invalid UTC offset: ${args[0]}`)
                return 'Invalid UTC offset'
            }
            const date = new Date()
            date.setUTCHours(date.getUTCHours() + utcOffset)
            return date.toISOString().replace('T', ' ').slice(0, -5)
        }
        case 'timeDiff': {
            return getTimeDiff(args[0], args[1])
        }
        case 'date':
            return new Date().toISOString().split('T')[0]
        case 'weekday':
            return [
                'Sunday',
                'Monday',
                'Tuesday',
                'Wednesday',
                'Thursday',
                'Friday',
                'Saturday'
            ][new Date().getDay()]
        case 'isotime':
            return new Date().toISOString().slice(11, 19)
        case 'isodate':
            return new Date().toISOString().split('T')[0]
        case 'random': {
            logger.debug(`Random function called with args: ${args.join(', ')}`)
            if (args.length === 2) {
                const [min, max] = args.map(Number)
                if (!isNaN(min) && !isNaN(max)) {
                    const result = Math.floor(
                        Math.random() * (max - min + 1) + min
                    ).toString()
                    logger.debug(
                        `Generated random number between ${min} and ${max}: ${result}`
                    )
                    return result
                }
            }
            const result = selectFromList(args.join(','), false)
            logger.debug(`Selected random item from list: ${result}`)
            return result
        }
        case 'pick':
            return selectFromList(args.join(','), true)
        case 'roll':
            return rollDice(args[0]).toString()
        default:
            return `{${func}${args.length ? ':' + args.join('::') : ''}}`
    }
}

export function formatMessages(
    messages: BaseMessage[],
    inputVariables: Record<string, string>
): BaseMessage[] {
    return messages.map((message) => {
        message.content = formatPresetTemplateString(
            message.content as string,
            inputVariables
        )
        return message
    })
}

export function formatPresetTemplate(
    presetTemplate: PresetTemplate,
    inputVariables: Record<string, string>,
    returnVariables: boolean = false
): BaseMessage[] | [BaseMessage[], string[]] {
    const variables: string[] = []

    // Create a deep copy of the messages array
    const formattedMessages = presetTemplate.messages.map((message) => {
        const content = formatPresetTemplateString(
            message.content as string,
            inputVariables,
            variables
        )

        const messageInstance = new {
            human: HumanMessage,
            ai: AIMessage,
            system: SystemMessage
        }[message._getType()]({
            content,
            additional_kwargs: message.additional_kwargs
        })

        return messageInstance
    })

    if (returnVariables) {
        return [formattedMessages, variables]
    }

    return formattedMessages
}
