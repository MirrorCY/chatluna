import { randomUUID } from 'crypto'
import { writeFileSync } from 'fs'
import { Context } from 'koishi'
import { BaseMessage } from 'langchain/schema'
import { createContext, Script } from 'vm'
import { logger } from '.'

// https://github.com/ading2210/poe-api/blob/291cb3fd2494061076b7a05c2ebefcbb9b935e69/src/poe/__init__.py#L210
export function extractFormKey(
    html: string,
    appScript: string
): [string, string | null] {
    const scriptRegex = /<script>(.+?)<\/script>/g
    const varsRegex = /window\._([a-zA-Z0-9]{10})="([a-zA-Z0-9]{10})"/
    const [key, value] = varsRegex.exec(appScript)!.slice(1)

    let scriptText = `
      let process = undefined;
      let document = {a: 1};
      let window = {
        document : {a: 1},
        navigator: {
          userAgent: 'aaa'
        }
      };
    `

    scriptText += `window._${key} = '${value}';`

    scriptText += [...html.matchAll(scriptRegex)]
        .map((match) => match[1])
        .filter((script) => !script.includes('__CF$cv$params'))
        .join('\n\n')

    writeFileSync('data/chathub/temp/poe_html.html', html)

    const functionRegex = /(window\.[a-zA-Z0-9]{17})=function/
    const functionText = functionRegex.exec(scriptText)[1]
    scriptText += `${functionText}().slice(0, 32);`

    writeFileSync('data/chathub/temp/script_text.js', scriptText)

    const context = createContext()
    let script = new Script(scriptText)
    const formKey = script.runInContext(context)

    let salt: string | null = null
    try {
        const saltFunctionRegex =
            /function (.)\(_0x[0-9a-f]{6},_0x[0-9a-f]{6},_0x[0-9a-f]{6}\)/
        const saltFunction = saltFunctionRegex.exec(scriptText)![1]
        const saltScript = `${saltFunction}(a=>a, '', '');`
        // 使用 nodejs vm 来执行 salt_script
        script = new Script(saltScript)
        salt = script.runInContext(context)
    } catch (e) {
        logger.warn('Failed to obtain poe-tag-id salt: ' + e.toString())
    }

    // bug extract salt
    return [formKey, salt]
}

export function calculateClientNonce(size: number) {
    /* e=>{
        let a = ""
          , n = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"
          , t = 0;
        for (; t < e; )
            a += n.charAt(Math.floor(Math.random() * n.length)),
            t += 1;
        return a
    } */
    let a = ''
    const n = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
    let t = 0

    for (; t < size; ) {
        a += n.charAt(Math.floor(Math.random() * n.length))
        t += 1
    }

    return a
}

// https://github.com/ading2210/poe-api/blob/b40ea0d0729b6a9ba101f191b34ffaba1449d34d/poe-api/src/poe.py#L75
export async function queryOrCreateDeviceId(ctx: Context, userId: string) {
    const cache = ctx.chatluna.cache

    let deviceId = await cache.get('poe_device_id_' + userId)

    if (deviceId != null) {
        return deviceId
    }

    deviceId = randomUUID()

    await cache.set('poe_device_id_' + userId, deviceId)

    return deviceId
}

export const maxTokenCount = (model: string) => {
    if (model.includes('100k')) {
        return 100000
    } else if (model.includes('gpt-4')) {
        return 8192
    } else if (model.includes('16k')) {
        return 16 * 1024
    } else {
        return 4096
    }
}

export function formatMessages(messages: BaseMessage[]) {
    const formatMessages: BaseMessage[] = [...messages]

    const result: string[] = []

    result.push(
        // eslint-disable-next-line max-len
        '\nThe following is a friendly conversation between a user and an ai. The ai is talkative and provides lots of specific details from its context. The ai use the ai prefix. \n\n'
    )

    for (const message of formatMessages) {
        const roleType =
            message._getType() === 'human' ? 'user' : message._getType()
        const formatted = `${roleType}: ${message.content}`

        result.push(formatted)
    }

    return result.join('\n\n')
}

export const QueryHashes = {
    messageAdded:
        '6d5ff500e4390c7a4ee7eeed01cfa317f326c781decb8523223dd2e7f33d3698',
    viewerStateUpdated:
        'ee640951b5670b559d00b6928e20e4ac29e33d225237f5bdfcb043155f16ef54',
    subscriptionsMutation:
        '5a7bfc9ce3b4e456cd05a537cfa27096f08417593b8d9b53f57587f3b7b63e99',
    sendMessageMutation:
        '5ae0b0c8598bce8d17fde5fa09a5e40257bf7cf3841d5adb128502f5331aab83',
    availableBotsSelectorModalPaginationQuery:
        'dd9281852c9a4d9d598f5a215e0143a8f76972c08e84053793567f7a76572593',
    BotSelectorModalQuery:
        'b1ed351177d82da55670039a971c647b87874d28c5e137b8eb9c9fdf7fb30f7b',
    HandleBotLandingPageQuery:
        'a0d7ca03635dab22140c589ad3f3705e71ed673c938b647764d117eaecd9343c',
    chatHelpersSendNewChatMessageMutation:
        '943e16d73c3582759fa112842ef050e85d6f0048048862717ba861c828ef3f82',
    sendChatBreakMutation:
        '62e344f18eb96c781f6560a42ef101287b3564b5d6acfb5190773342c71a043e'
}

export type QueryVariables = keyof typeof QueryHashes

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export interface RequestBody extends Record<string, any> {
    queryName: QueryVariables
    extensions?: Record<string, unknown>
}
