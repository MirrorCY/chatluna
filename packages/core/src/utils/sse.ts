import * as fetchType from 'undici/types/fetch'
import { ChatLunaError, ChatLunaErrorCode } from './error'

// eslint-disable-next-line generator-star-spacing
export async function* sseIterable(
    response: fetchType.Response | ReadableStreamDefaultReader<string>,
    checkedFunction?: (
        data: string,
        event?: string,
        kvMap?: Record<string, string>
    ) => boolean,
    mappedFunction?: (data: string) => string | Error
) {
    if (!(response instanceof ReadableStreamDefaultReader) && !response.ok) {
        const error = await response.json().catch(() => ({}))

        throw new ChatLunaError(
            ChatLunaErrorCode.NETWORK_ERROR,
            new Error(
                `${response.status} ${response.statusText} ${JSON.stringify(
                    error
                )}`
            )
        )
    }

    const reader =
        response instanceof ReadableStreamDefaultReader
            ? response
            : response.body.getReader()

    const decoder = new TextDecoder('utf-8')

    try {
        while (true) {
            const { value, done } = await reader.read()

            let decodeValue = decoder.decode(value)

            if (mappedFunction) {
                const mappedValue = mappedFunction(decodeValue)

                if (mappedValue instanceof Error) {
                    throw mappedValue
                }

                decodeValue = mappedValue
            }

            if (done) {
                yield '[DONE]'
                return
            }

            if (decodeValue.trim().length === 0) {
                continue
            }

            const splitted = decodeValue
                .split('\n\n')
                .flatMap((item) => item.split('\n'))

            let currentTemp: Record<string, string> = {}

            for (let i = 0; i < splitted.length; i++) {
                const item = splitted[i]

                if (item.trim().length === 0) {
                    continue
                }

                // data: {aa:xx}
                // event:finish

                const [, type, data] = /(\w+):\s*(.*)$/g.exec(item) ?? [
                    '',
                    '',
                    ''
                ]

                currentTemp[type] = data

                if (type !== 'data') {
                    continue
                }

                if (checkedFunction) {
                    const result = checkedFunction(
                        data,
                        currentTemp?.['event'],
                        currentTemp
                    )

                    if (result) {
                        yield data
                    }

                    currentTemp = {}
                    continue
                }

                currentTemp = {}

                yield data
            }
        }
    } finally {
        reader.releaseLock()
    }
}
