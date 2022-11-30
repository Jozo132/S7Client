// Written by: J.Vovk <jozo132@gmail.com>
// Date: 15.11. 2022

//@ts-check
'use strict'

// Note: The port option does not work yet. Inside the snap7 library the port is always set to 102.

/** @typedef { 'SINT' | 'USINT' | 'INT' | 'UINT' | 'WORD' | 'DINT' | 'UDINT' | 'DWORD' | 'REAL' | 'FLOAT' | 'LREAL' | 'DOUBLE' | 'sint' | 'usint' | 'int' | 'uint' | 'word' | 'dint' | 'udint' | 'dword' | 'real' | 'float' | 'lreal' | 'double' | 'CHAR' | 'STRING' | 'char' | 'string' | 'BOOL' | 'BIT' | 'BYTE' | 'bool' | 'bit' | 'byte' | 'TIME' | 'time' | 'TIMER' | 'timer' | 'S5TIME' | 's5time' | 'IEC_TIMER' | 'iec_timer' } DataType */
/** @typedef { Boolean | Number | String | Boolean[] | Number[] | String[] } S7DBDataValueType */
/** @typedef {{ name: String; type: DataType; strlen?: Number; size?: Number, value?: S7DBDataValueType, offset?: Number | String }} S7DBStructureItem */
/** @typedef {{ name?: String; port?: Number; host: String; rack?: Number; slot?: Number; bufferSize?: Number; staticSize?: Number;  timeout?: Number; debug?: Boolean }} S7DBConfig */
/** @typedef {{ name?: String; db: Number; offset: Number; refresh?: Number; items: S7DBStructureItem[] }} S7DBStructure */
/** @typedef {{ name: String; type: DataType; value: S7DBDataValueType }} S7DBData */
/** @typedef {{ config: S7DBConfig, datablocks: S7DBStructure | S7DBStructure[] }} S7DBGetInputObject */
/** @typedef {{ config: S7DBConfig, datablocks: S7DBStructure[] }} S7DBPLCHandlerObject */

const numberTypes = ['SINT', 'USINT', 'INT', 'UINT', 'WORD', 'DINT', 'UDINT', 'DWORD', 'REAL', 'FLOAT', 'LREAL', 'DOUBLE', 'BIT', 'BYTE', 'TIME', 'TIMER', 'S5TIME']
const objectTypes = ['IEC_TIMER']
const typeIsNumber = type => numberTypes.includes(type.toLocaleUpperCase())
const typeIsObject = type => objectTypes.includes(type.toLocaleUpperCase())
const isBoolean = type => type === 'BIT' || type === 'BOOL'
const isString = type => type === 'STRING'
const roundUpToEven = n => n + n % 2

const delay = ms => new Promise(r => setTimeout(r, ms))

const typeList = {
    SINT: 1, // sint 8
    USINT: 1, // usint 8
    INT: 2, // int 16
    UINT: 2, // uint 16
    WORD: 2, // uint 16
    DINT: 4, // int 32
    UDINT: 4, // uint 32
    DWORD: 4, // uint 32
    REAL: 4, // float 32
    FLOAT: 4, // float 32
    LREAL: 8, // double 32
    DOUBLE: 8, // double 32
    CHAR: 1,
    STRING: 256, // default used size is 256
    BIT: 1,
    BOOL: 1,
    BYTE: 1,
    TIME: 4,
    TIMER: 4,
    S5TIME: 2,
    IEC_TIMER: 16,
}


/** @param {Buffer} buffer * @param {number} offset * @param {number} index * @returns {boolean} */
const parseBooleanFromBuffer = (buffer, offset, index) => {
    const i = index % 8
    const add = index > 7 ? 1 : 0
    const byte = buffer.readInt8(offset + add)
    return ((byte >> i) & 1) ? true : false
}

const parseTimeFromBuffer = (buffer, offset) => {
    const value = buffer.readUInt32BE(offset)
    return value // Raw milliseconds
}

const S5Time_timebase = [10, 100, 1000, 10000]
const parseS5TimeFromBuffer = (buffer, offset) => {
    const raw_value = buffer.readUInt16BE(offset)
    const factor = (raw_value & 0x3000) >> 12 // 0x3000 = 00110000 00000000
    const value = +(raw_value & 0x0FFF).toString(16) // 0x0FFF = 00001111 11111111
    const output = value * S5Time_timebase[factor]
    return output
}

const parseIECTimerFromBuffer = (buffer, offset) => {
    const output = [
        { name: "start", type: 'UDINT', size: 1, value: parseValueFromBuffer(buffer, 'UDINT', offset) },
        { name: "PT", type: 'TIME', size: 1, value: parseValueFromBuffer(buffer, 'TIME', offset + 4) },
        { name: "ET", type: 'TIME', size: 1, value: parseValueFromBuffer(buffer, 'TIME', offset + 8) },
        { name: "IN", type: 'BOOL', size: 1, value: parseValueFromBuffer(buffer, 'BOOL', offset + 12, 0) },
        { name: "Q", type: 'BOOL', size: 1, value: parseValueFromBuffer(buffer, 'BOOL', offset + 12, 1) },
        { name: "end", type: 'UINT', size: 1, value: parseValueFromBuffer(buffer, 'UINT', offset + 14) },
    ]
    return output
}

// ######## S7 String type definition examples ########
// The S7 String type is a variable length string.
// The first byte contains the total length of the included string.
// The second byte contains the actual used length of the included string.
// The remaining bytes contain the string characters.
// The string is never null terminated.
// The used up buffer size is the total length of the string plus two bytes.
// The buffer size is always a multiple of 2.
// The string is always stored in ASCII format.
// Example:
// STRING[10] = "TEST"
// BufferArray: [10, 4, 'T', 'E', 'S', 'T', 0, 0, 0, 0, 0, 0] => used buffer size = 12
// STRING[3] = "Ok"
// BufferArray: [3, 2, 'O', 'k', 0, 0] => used buffer size = 6
// STRING[7] = "Test"
// BufferArray: [7, 4, 'T', 'e', 's', 't', 0, 0, 0, 0] => used buffer size = 10

/** @param {string} type * @returns {number} */
const variableTypeSize = type => typeList[(type || '').toLocaleUpperCase()] || 2 // int 16 (default)

const stringTypeSize = (buffer, offset) => {
    let max_length = buffer.readUInt8(offset);
    max_length += 2
    max_length += max_length % 2
    return max_length
}


/** @param { S7DBStructureItem[] } items * @param { Number } [start_offset] * @returns { number } */
const DBStructure_calculateSize = (items, start_offset = 0) => {
    let total_size = 0
    let used_bits = 0
    const num_of_items = items.length
    for (let i = 0; i < num_of_items; i++) {
        const item = items[i] // @ts-ignore
        item.type = item.type ? item.type.toLocaleUpperCase() : 'UINT'
        item.size = item.size && item.size > 0 ? Math.round(item.size) : 1
        const { type, size } = item
        const isStr = isString(type)
        const isBool = isBoolean(type)
        if (isStr) item.strlen = item.strlen || 254
        const strlen_temp = isStr ? (item.strlen || 0) + 2 : 0
        const strlen = strlen_temp + (strlen_temp % 2) // Round up to even
        const typesize = isStr ? strlen : variableTypeSize(type)
        if (used_bits > 0 && !isBool) {
            total_size++
            used_bits = 0
            if (typesize > 1) total_size = roundUpToEven(total_size)
        }
        if (isStr) total_size = roundUpToEven(total_size)
        const offset = (start_offset + total_size + 0.1 * used_bits).toFixed(1)
        item.offset = offset
        if (size > 1) { // Handle variable arrays
            if (used_bits > 0) total_size++
            used_bits = 0
            total_size = roundUpToEven(total_size)
            if (isBool) total_size += 2 * Math.ceil(size / 16)
            else total_size += typesize * size
            total_size = roundUpToEven(total_size)
        } else { // Handle single variable entry
            if (isBool) {
                used_bits++;
                if (used_bits >= 8) {
                    total_size++
                    used_bits = 0
                }
            } else {
                if (used_bits > 0) {
                    total_size++
                    used_bits = 0
                }
                if (typesize > 1) total_size = roundUpToEven(total_size)
                total_size += typesize
            }
        }
    }
    // console.log('Computed structure:', items)
    if (used_bits > 0) total_size++
    total_size = roundUpToEven(total_size)
    return total_size
}

// ###### DECODING #######
/** @param {Buffer} buffer * @param {number} offset * @returns {string} */
const parseCharacterFromBuffer = (buffer, offset) => String.fromCharCode(buffer.readUInt8(offset))

/** @param {Buffer} buffer * @param {number} offset * @param {number} [expected_strlen] */
const parseStringFromBuffer = (buffer, offset, expected_strlen = 256) => {
    let output = '';
    try {
        const actual_strlen = stringTypeSize(buffer, offset)
        if (expected_strlen && expected_strlen !== actual_strlen) {
            const remaining = expected_strlen - actual_strlen
            if (remaining < 0) console.log(`String parsing error: expected size ${expected_strlen} but got ${actual_strlen} at offset ${offset}`)
        }
        const strlen = buffer.readUInt8(offset + 1);
        for (let i = 0; i < strlen; i++) output += parseCharacterFromBuffer(buffer, offset + 2 + i);
    } catch (e) { console.error(`S7 internal parseStringFromBuffer STRING ${offset} - ${e.toString()}`) }
    return output
}

/** @param {Buffer} buffer  * @param {DataType} type * @param {number} offset * @param {number} [i] * @param {number} [expected_strlen] * @returns {boolean | number | string | any[]} */
const parseValueFromBuffer = (buffer, type, offset, i = 0, expected_strlen) => {
    try {
        switch ((type || 'UINT').toLocaleUpperCase()) {
            case 'BIT': return parseBooleanFromBuffer(buffer, offset, i)
            case 'BOOL': return parseBooleanFromBuffer(buffer, offset, i)
            case 'BYTE': return buffer.readUInt8(offset)
            case 'SINT': return buffer.readInt8(offset)
            case 'USINT': return buffer.readUInt8(offset)
            case 'INT': return buffer.readInt16BE(offset)
            case 'UINT': return buffer.readUInt16BE(offset)
            case 'WORD': return buffer.readUInt16BE(offset)
            case 'DINT': return buffer.readInt32BE(offset)
            case 'UDINT': return buffer.readUInt32BE(offset)
            case 'DWORD': return buffer.readUInt32BE(offset)
            case 'REAL': return buffer.readFloatBE(offset)
            case 'FLOAT': return buffer.readFloatBE(offset)
            case 'LREAL': return buffer.readDoubleBE(offset)
            case 'DOUBLE': return buffer.readDoubleBE(offset)
            case 'CHAR': return parseCharacterFromBuffer(buffer, offset)
            case 'STRING': return parseStringFromBuffer(buffer, offset, expected_strlen)
            case 'TIME': return parseTimeFromBuffer(buffer, offset)
            case 'TIMER': return parseTimeFromBuffer(buffer, offset)
            case 'S5TIME': return parseS5TimeFromBuffer(buffer, offset)
            case 'IEC_TIMER': return parseIECTimerFromBuffer(buffer, offset)
            default: return buffer.readUInt16BE(offset)
        }
    } catch (e) {
        const e_msg = `S7 internal parseValueFromBuffer ${type} ${offset} - ${e.toString()}`
        console.error(e_msg)
        return e_msg
    }
}



/** @param {DBStructure} db * @param {Buffer} buffer * @returns { S7DBData[] } */
const DBStructure_parse = (db, buffer, debug) => {
    buffer = Buffer.from(buffer)
    if (debug) console.log('Parsing buffer:', buffer)
    /** @type {S7DBData[]} */
    let output = []
    let offset = 0
    let bits = 0
    const num_of_items = db.items.length
    for (let i = 0; i < num_of_items; i++) {
        const item = db.items[i] // @ts-ignore
        item.type = item.type.toLocaleUpperCase()
        const { name, type, size } = item
        const isBool = isBoolean(type)
        const isStr = isString(type)
        const isNumber = typeIsNumber(type)
        const strlen_temp = (item.strlen || 254) + 2
        const strlen = strlen_temp + (strlen_temp % 2) // Round up to even
        const typesize = isStr ? strlen : variableTypeSize(type)
        if (isBool && size && size > 1) {
            if (bits > 0) offset++
            bits = 0
        } else {
            if (isBool) bits++;
            else {
                if (bits > 0) offset++
                bits = 0
            }
        }
        /** @type { { name: string, type: string, value: S7DBDataValueType | undefined } } */
        const result = { name, type, value: undefined }
        if (size && size > 1) {
            offset = roundUpToEven(offset)
            result.value = []
            for (let i = 0; i < size; i++) {
                let value = parseValueFromBuffer(buffer, type, offset, bits - 1, typesize)
                if (isNumber) value = isFinite(+value) ? +value : 0 // @ts-ignore
                result.value.push(isBool ? !!value : value)
                if (isBool) {
                    bits++
                    if (bits >= 8) {
                        offset++
                        bits = 0
                    }
                } else offset += typesize

            }
            offset = roundUpToEven(offset)
        } else {
            if (typesize > 1) offset = roundUpToEven(offset)
            result.value = parseValueFromBuffer(buffer, type, offset, bits - 1, typesize)
            offset += isBool ? 0 : typesize
            if (bits >= 8) {
                offset++
                bits = 0
            }
        }
        if (typeIsObject(type)) {
            if (size && size > 1 && Array.isArray(result.value)) {
                for (let i = 0; i < result.value.length; i++) {
                    const value_array = result.value[i]
                    if (Array.isArray(value_array)) {
                        for (let j = 0; j < value_array.length; j++) {
                            const { name, type, value } = value_array[j]
                            output.push({ name: `${result.name}[${i}].${name}`, type, value })
                        }
                    }
                }
            } else {  // @ts-ignore
                for (let i = 0; i < result.value.length; i++) {
                    const { name, type, value } = result.value[i]
                    output.push({ name: `${result.name}.${name}`, type, value })
                }
            } // @ts-ignore
        } else output.push(result)
    }
    return output
}





// ###### ENCODING #######
/** @param { Boolean } value * @param {Buffer} buffer * @param {number} offset * @param {number} index */
const encodeBooleanToBuffer = (value, buffer, offset, index) => {
    // Set or clear bit of buffer at offset and bit index to the given boolean value
    let byte = buffer.readUInt8(offset)
    if (value) byte |= (1 << index)  // SET index bit of byte
    else byte &= ~(1 << index)       // CLEAR index bit of byte
    buffer.writeUInt8(byte, offset)
}
/** @param {String} value *  @param {Buffer} buffer * @param {number} offset */
const encodeCharacterToBuffer = (value, buffer, offset) => buffer.writeUInt8(value.charCodeAt(0), offset)

/** @param {String} value * @param {Buffer} buffer * @param {number} offset * @param {number} strlen*/
const encodeStringToBuffer = (value, buffer, offset, strlen) => {
    const chars = value.split('')
    const cl = chars.length
    const strlen_max = strlen - 2
    const strlen_temp = cl > strlen_max ? strlen_max : cl
    buffer.writeUInt8(strlen_max, offset++)
    buffer.writeUInt8(strlen_temp, offset++)
    for (let i = 0; i < strlen_temp; i++)  encodeCharacterToBuffer(chars[i], buffer, offset++);
}
/** @param { number } value * @param { Buffer } buffer * @param { number } offset */
const encodeTimeToBuffer = (value, buffer, offset) => buffer.writeUInt32BE(value, offset)
/** @param { number } value * @param { Buffer } buffer * @param { number } offset */
const encodeS5TimeToBuffer = (value, buffer, offset) => {
    // Calculate the lowest factor for the given value
    // 0x0000 = 00001100 00000000 = 0ms
    // 0x0001 = 00001100 00000001 = 10ms
    // 0x0FFF = 00001111 11111111 = 9990ms
    // 0x1000 = 00011101 00000000 = 0ms
    // 0x1001 = 00011101 00000001 = 100ms
    // 0x1FFF = 00011111 11111111 = 99900ms
    // 0x2000 = 00101111 00000000 = 0ms
    // 0x2001 = 00101111 00000001 = 1000ms
    // 0x2FFF = 00101111 11111111 = 999000ms
    // 0x3000 = 00110000 00000000 = 0ms
    // 0x3001 = 00110000 00000001 = 10000ms
    // 0x3FFF = 00110000 11111111 = 9990000ms
    value = value > 9990000 ? 9990000 : value < 0 ? 0 : value
    const factor = value < 9990 ? 0 : value < 99900 ? 1 : value < 999000 ? 2 : 3
    const val = +((value / (10 ** (factor + 1))) | 0).toString().substring(0, 3)
    const output = (factor << 12) | (+('0x' + val) & 0x0FFF)
    buffer.writeUInt16BE(output, offset)
    //return output
}
const encodeIECTimerToBuffer = (value, buffer, offset) => {
    // Todo: Implement this
}

/** @param {Buffer} buffer * @param {S7DBDataValueType} value * @param {DataType} type * @param {number} offset * @param {number} [i] * @param {number} [strlen] */
const encodeValueToBuffer = (buffer, value, type, offset, i = 0, strlen = 254) => {
    try {
        switch ((type || 'UINT').toLocaleUpperCase()) {
            case 'BOOL': encodeBooleanToBuffer(!!value, buffer, offset, i); break;
            case 'BYTE': buffer.writeUInt8(+value, offset); break;
            case 'SINT': buffer.writeInt8(+value, offset); break;
            case 'USINT': buffer.writeUInt8(+value, offset); break;
            case 'INT': buffer.writeInt16BE(+value, offset); break;
            case 'UINT': buffer.writeUInt16BE(+value, offset); break;
            case 'WORD': buffer.writeUInt16BE(+value, offset); break;
            case 'DINT': buffer.writeInt32BE(+value, offset); break;
            case 'UDINT': buffer.writeUInt32BE(+value, offset); break;
            case 'DWORD': buffer.writeUInt32BE(+value, offset); break;
            case 'REAL': buffer.writeFloatBE(+value, offset); break;
            case 'FLOAT': buffer.writeFloatBE(+value, offset); break;
            case 'LREAL': buffer.writeDoubleBE(+value, offset); break;
            case 'DOUBLE': buffer.writeDoubleBE(+value, offset); break;
            case 'CHAR': encodeCharacterToBuffer(value + '', buffer, offset); break;
            case 'STRING': encodeStringToBuffer(value + '', buffer, offset, strlen); break;
            case 'TIME': encodeTimeToBuffer(+value, buffer, offset); break;
            case 'TIMER': encodeTimeToBuffer(+value, buffer, offset); break;
            case 'S5TIME': encodeS5TimeToBuffer(+value, buffer, offset); break;
            //case 'IEC_TIMER': encodeIECTimerToBuffer(value, buffer, offset); break;
            default: buffer.writeUInt16BE(+value, offset); break;
        }
    } catch (e) {
        const e_msg = `S7 internal encodeValueToBuffer ${type} ${offset} - ${e.toString()}`
        console.error(e_msg)
        return
    }
}


/** @param {DBStructure} db * @param {boolean} [debug] * @returns { Buffer } */
const DBStructure_encode = (db, debug) => {
    const buff_size = DBStructure_calculateSize(db.items, db.offset)
    /** @type {Buffer} */
    const buffer = Buffer.alloc(buff_size)
    if (debug) console.log('Encoding buffer:', buffer)
    let offset = 0
    let bits = 0
    const num_of_items = db.items.length
    for (let i = 0; i < num_of_items; i++) {
        const item = db.items[i] // @ts-ignore
        item.type = item.type.toLocaleUpperCase()
        const { name, value, type, size } = item
        const isBool = isBoolean(type)
        const isStr = isString(type)
        const strlen_temp = (item.strlen || 254) + 2
        const strlen = strlen_temp + (strlen_temp % 2) // Round up to even number
        const typesize = isStr ? strlen : variableTypeSize(type)
        if (isBool && size && size > 1) {
            if (bits > 0) offset++
            bits = 0
        } else {
            if (isBool) {
                bits++
            } else {
                if (bits > 0) offset++
                bits = 0
            }
        }
        if (size && size > 1 && Array.isArray(value)) {
            offset = roundUpToEven(offset)
            for (let i = 0; i < size; i++) {
                const val = value[i]
                const v = typeIsNumber(type) ? (isFinite(+val) ? +val : 0) : val
                if (!typeIsObject(type)) encodeValueToBuffer(buffer, v, type, offset, bits - 1, typesize)
                if (isBool) {
                    bits++
                    if (bits >= 8) {
                        offset++
                        bits = 0
                    }
                } else offset += typesize
            }
            offset = roundUpToEven(offset)
        } else {
            if (typesize > 1 || isString(type)) offset = roundUpToEven(offset) // @ts-ignore
            const v = typeIsNumber(type) ? (isFinite(+value) ? +value : 0) : value // @ts-ignore
            if (!typeIsObject(type)) encodeValueToBuffer(buffer, v, type, offset, bits - 1, typesize)
            offset += isBool ? 0 : typesize
            if (bits >= 8) {
                offset++
                bits = 0
            }
        }
    }
    return buffer
}






class DBStructure {
    /** @param {{ name?: String; db: Number; offset?: Number; items: S7DBStructureItem[] }} input */
    constructor(input) {
        const { name, db, offset, items } = input
        /** @type { String } */
        this.name = name || 'Default'
        /** @type { Number } */
        this.db = db >= 0 ? db : 10
        /** @type { Number } */
        this.offset = offset ? offset >= 0 ? offset : 0 : 0
        /** @type { S7DBStructureItem[] } */
        this.items = items || []
        /** @type { Number } */
        this.size = DBStructure_calculateSize(this.items, offset)
    }
}







// @ts-ignore
const { S7Client } = require('node-snap7')

const reusable_s7_connections = {}

class S7 {
    /** @param { S7DBConfig } [input] */
    constructor(input) {
        const { port, host, rack, slot, bufferSize, staticSize, debug } = input || {}
        this.debug = debug || false
        this.host = host || 'localhost'
        this.port = port || 102
        this.rack = rack || 0
        this.slot = slot || 1
        this.staticSize = staticSize || 0
        this.bufferSize = bufferSize || 0
        this.client = new S7Client()
        this.connected = false
        this.disconnectTimeout = undefined
    }
    /** @param { S7DBConfig } [input] */
    connect = (input) => new Promise((resolve, reject) => {
        const { port, host, rack, slot, bufferSize, staticSize, debug } = input || {}
        this.debug = debug || this.debug || false
        this.host = host || this.host || 'localhost'
        this.port = port || this.port || 102
        this.rack = rack || this.rack || 0
        this.slot = slot || this.slot || 1
        this.staticSize = staticSize || this.staticSize || 0
        this.bufferSize = bufferSize || this.bufferSize || 0
        if (this.connected) {
            if (this.debug) console.log(`Reusing open connection S7 client on: ${this.host}:${this.port} rack:${this.rack} slot:${this.slot}`)
            resolve('connected')
            return
        }
        if (this.debug) console.log(`Connecting S7 client on: ${this.host}:${this.port} rack:${this.rack} slot:${this.slot}`)
        this.client.ConnectTo(this.host, this.rack, this.slot, err => {
            if (err) {
                if (this.debug) console.log(`Failed to connect S7 client on: ${this.host}:${this.port} rack:${this.rack} slot:${this.slot}`)
                this.connected = false
                reject(`${err}:${this.client.ErrorText(err)}`)
                return
            }
            if (this.debug) console.log(`Connected to connect S7 client on: ${this.host}:${this.port} rack:${this.rack} slot:${this.slot}`)
            this.connected = true
            resolve('connected')
        })
    })
    disconnect = () => { if (this.disconnectTimeout) clearTimeout(this.disconnectTimeout); this.disconnectTimeout = setTimeout(() => { try { this.client.Disconnect() } catch (e) { } }, 500) }
    /** @param {Number} db * @param {Number} offset * @param {Number} size * @returns {Promise<Buffer>} */
    read_default = (db, offset, size) => new Promise((res, rej) => { this.client.DBRead(db, offset, size, (/**@type {any}*/ err, /**@type {Buffer}*/ raw_buffer) => { if (err) rej(err); else res(raw_buffer) }) })
    /** @param {Number} db * @param {Number} offset * @param {Number} size * @param {Buffer} buff * @returns {Promise<void>} */
    write_default = (db, offset, size, buff) => new Promise((res, rej) => this.client.DBWrite(db, offset, size, buff, err => { if (err) rej(err); else res() }))
    /**
     * @param { S7DBStructure } input_db
     * @returns { Promise<S7DBData[]> }
     */
    read = async input_db => {
        let t = +new Date()
        const datablock = new DBStructure(input_db)
        if (this.staticSize) datablock.size = this.staticSize
        if (this.debug) {
            /** @type { any } */
            const temp = { ...datablock }
            temp.nrOfItems = temp.items.length
            delete temp.items
            console.log(temp)
        }
        if (datablock.size > 0) {
            if (!this.connected) await this.connect()
            const { db, offset, size } = datablock
            const connection_options = `S7 Read IP: ${this.host} | DB: ${db} | offset: ${offset} | size: ${size}`
            if (this.debug) console.log(connection_options)



            const read_with_retries = async (db, offset, size, retries = 3) => {
                try {
                    const output = await this.read_default(db, offset, size)
                    return output
                } catch (e) {
                    if (this.debug) console.log(`S7Client - Failed to read size ${size} from DB${db}${offset > 0 ? `+${offset}` : ''} Error:`, e)
                    if (retries > 1) {
                        retries--
                        const output = await read_with_retries(db, offset, size, retries)
                        return output
                    } else {
                        throw e
                    }
                }
            }

            let buffer = undefined
            let err = undefined
            if (this.bufferSize > 0 && size > this.bufferSize) {
                // Batch requests
                try {
                    const buff_array = []
                    const { bufferSize } = this
                    const batchCount = Math.ceil(size / bufferSize)
                    for (let i = 0; i < batchCount; i++) {
                        const s = i < batchCount - 1 ? bufferSize : (size - (i * bufferSize))
                        if (this.debug) console.log(`Processing batch (${i + 1}/${batchCount})  DB: ${db} | offset: ${offset + i * bufferSize} | size: ${s}`)
                        if (s > 0) {
                            const buff = await read_with_retries(db, offset + i * bufferSize, s)
                            buff_array.push(buff)
                        }
                    }
                    buffer = Buffer.concat(buff_array.map(b => new Uint8Array(b)))
                } catch (e) { err = e }
            } else {
                try {
                    if (this.debug) console.log(`Processing single request  DB: ${db} | offset: ${offset} | size: ${size}`)
                    buffer = await read_with_retries(db, offset, size)
                } catch (e) { err = e }
            }

            if (err) throw `${connection_options}\nError[${err}]: ${this.client.ErrorText(err)}`
            try {
                const output = DBStructure_parse(datablock, buffer, this.debug)
                if (this.debug) console.log(`Processed S7 Read command in ${+new Date() - t} ms`)
                return (output)
            } catch (e) { throw `Failed to parse S7 DB: ${e}` }
        } else return []
    }

    /** @param { S7DBConfig } config * @param { S7DBStructure } input_db * @returns { Promise<S7DBData[]> } */
    static read = async (config, input_db) => {
        const { host } = config
        reusable_s7_connections[host] = reusable_s7_connections[host] || { timeout: undefined, client: new S7(config) }
        const connection = reusable_s7_connections[host]
        reusable_s7_connections[host] = undefined
        // if (connection.timeout) clearTimeout(connection.timeout)
        // connection.timeout = setTimeout(() => {
        //     connection.timeout = undefined
        //     connection.client.disconnect()
        // }, 10)
        const client = connection.client
        const db = new DBStructure(input_db)
        try {
            client.connect()
            const data = await client.read(db)
            client.disconnect()
            return data
        } catch (e) {
            client.disconnect()
            throw { error: e, request: db }
        }
    }


    /** @param { S7DBStructure } input_db * @returns { Promise<void> } */
    write = async input_db => {
        let t = +new Date()
        const datablock = new DBStructure(input_db)
        if (this.staticSize) datablock.size = this.staticSize
        if (this.debug) {
            /** @type { any } */
            const temp = { ...datablock }
            temp.nrOfItems = temp.items.length
            delete temp.items
            console.log(temp)
        }
        if (datablock.size > 0) {
            if (!this.connected) await this.connect()
            const { db, offset, size } = datablock
            const buffer = DBStructure_encode(datablock)

            const connection_options = `S7 Write IP: ${this.host} | DB: ${db} | offset: ${offset} | size: ${size}`
            if (this.debug) console.log(connection_options)


            /** @param {Number} db * @param {Number} offset * @param {Number} size * @param {Buffer} buff */
            const write_with_retries = async (db, offset, size, buff) => {
                /** @type {[ Number, Number, Number, Buffer ]} */
                const request = [db, offset, size, buff]
                const info = `DB: ${db} | offset: ${offset} | size: ${size} | buff: 0x${this.debug ? buff.toString('hex') : buff.length}`
                const success_msg = `S7 Write success: ${info}`
                const fail_msg = `S7 Write failed: ${info}`
                try {
                    const output = await this.write_default(...request)
                    if (this.debug) console.log(success_msg)
                    return output
                } catch (e) {
                    console.log(fail_msg)
                    throw new Error(`${fail_msg}: ${JSON.stringify(e)}`)
                }
            }

            let err = undefined

            try {
                if (this.debug) console.log(`Processing single request  DB: ${db} | offset: ${offset} | size: ${size}`)
                await write_with_retries(db, offset, size, buffer)
            } catch (e) { err = e }

            if (err) {
                console.log(buffer)
                console.log(buffer.toString('hex'))
                console.error(`${connection_options}\nError[${err}]: ${err.toString()}`)
                throw err
            }
            if (this.debug) console.log(`Processed S7 Write command in ${+new Date() - t} ms`)
        }
    }


    /** @param { S7DBConfig } config * @param { S7DBStructure } input_db * @returns { Promise<void> } */
    static write = async (config, input_db) => {
        const { host } = config
        reusable_s7_connections[host] = reusable_s7_connections[host] || { timeout: undefined, client: new S7(config) }
        const connection = reusable_s7_connections[host]
        reusable_s7_connections[host] = undefined
        // if (connection.timeout) clearTimeout(connection.timeout)
        // connection.timeout = setTimeout(() => {
        //     connection.timeout = undefined
        //     connection.client.disconnect()
        // }, 15000)
        const db = new DBStructure(input_db)
        const client = connection.client
        client.connect()
        await client.write(db)
        client.disconnect()
    }
}


class SequentialRequests {
    constructor(timeoutReset) {
        this.sequences = {}
        this.timeoutReset = timeoutReset || 5000
    }
    isAvailable(x) {
        this.sequences[x] = this.sequences[x] || { available: true, timeout: undefined }
        const existing = this.sequences[x]
        let output = false
        if (existing.available) {
            existing.available = false
            existing.timeout = setTimeout(() => {
                existing.available = true
            }, this.timeoutReset)
            output = true
        }
        return output
    }
    setAvailable(x) {
        this.sequences[x] = this.sequences[x] || { available: true, timeout: undefined }
        const existing = this.sequences[x]
        clearTimeout(existing.timeout)
        existing.available = true
    }
}
const s = new SequentialRequests(5000)
const isAvailable = x => s.isAvailable(x)
const setAvailable = x => s.setAvailable(x)

/** @param { S7DBConfig } config * @param { S7DBStructure | S7DBStructure[] } db * @returns { Promise<S7DBData[]> } */
const getS7Data = async (config, db) => {
    if (Array.isArray(db)) {
        const output = []
        for (let i = 0; i < db.length; i++) {
            try {
                const result = await getS7Data(config, db[i])
                if (result) output.push(...result)
            } catch (e) { output.push(e) }
            if (i < db.length - 1) await delay(5)
        }
        return output
    } else {
        for (let i = 0; i < 20; i++) {
            if (i < 19) await delay(50 * i)
            if (isAvailable(config.host)) {
                try {
                    const result = await S7.read(config, db)
                    setAvailable(config.host)
                    return result
                } catch (e) {
                    setAvailable(config.host)
                    throw e
                }
            }
        }
    }
    throw '113: TCP : Unreachable peer'
}


/** @param { S7DBConfig } config * @param { S7DBStructure | S7DBStructure[] } db * @returns { Promise<void> } */
const setS7Data = async (config, db) => {
    if (Array.isArray(db)) {
        const output = []
        for (let i = 0; i < db.length; i++) {
            try {
                await setS7Data(config, db[i])
                output.push(false)
            } catch (e) { output.push(e) }
            if (i < db.length - 1) await delay(5)
        }
        // If all outputs are false, then it's all okay
        if (output.every(x => x === false)) return
        else throw output
    } else {
        for (let i = 0; i < 20; i++) {
            if (i < 19) await delay(50 * i)
            if (isAvailable(config.host)) {
                try {
                    await S7.write(config, db)
                    setAvailable(config.host)
                    return
                } catch (e) {
                    setAvailable(config.host)
                    throw e
                }
            }
        }
    }
    throw '113: TCP : Unreachable peer'
}

// S7DBGetInputObject | S7DBGetInputObject[]
const readPLC = async (/** @type { S7DBGetInputObject[] } */ ...args) => {
    const PLC = args.length === 1 ? args[0] : args
    if (Array.isArray(PLC)) {
        const output = []
        for (let i = 0; i < PLC.length; i++) {
            const { config, datablocks } = PLC[i]
            try { output.push(await getS7Data(config, datablocks)) }
            catch (e) { output.push(e) }
            if (i < PLC.length - 1) await delay(5)
        }
        return output
    } else {
        const { config, datablocks } = PLC
        return await getS7Data(config, datablocks)
    }
}


// S7DBGetInputObject | S7DBGetInputObject[]
const writePLC = async (/** @type { S7DBGetInputObject[] } */ ...args) => {
    const PLC = args.length === 1 ? args[0] : args
    if (Array.isArray(PLC)) {
        const output = []
        for (let i = 0; i < PLC.length; i++) {
            const { config, datablocks } = PLC[i]
            try { output.push(await setS7Data(config, datablocks)) }
            catch (e) { output.push(e) }
            if (i < PLC.length - 1) await delay(5)
        }
        return output
    } else {
        const { config, datablocks } = PLC
        return await setS7Data(config, datablocks)
    }
}

const block2object = block => {
    const output = {}
    for (let i = 0; i < block.length; i++) {
        const { name, value } = block[i]
        output[name] = value
    }
    return output
}

const object2block = object => {
    const output = []
    for (const key in object) {
        output.push({ name: key, value: object[key] })
    }
    return output
}

/** @param { S7DBPLCHandlerObject } PLC */
const PLC_handler = PLC => {
    const { config, datablocks } = PLC
    for (let i = 0; i < datablocks.length; i++) {
        const datablock = datablocks[i]
        const { offset, items } = datablock
        DBStructure_calculateSize(items, offset)
    }
    const write = async (...variables) => {
        if (variables.length === 0) return { error: 'No values given!' }
        variables = variables.length > 1 ? variables : variables[0]
        variables = Array.isArray(variables) ? variables : [variables]
        for (let i = 0; i < variables.length; i++) {
            if (typeof variables[i] !== 'object') return { error: `Variable [${i + 1}/${variables.length}] is not an object!` }
            const { name, value } = variables[i]
            if (!name) return { error: `Variable [${i + 1}/${variables.length}] parameter "name" is not defined!` }
            if (value === undefined) return { error: `Variable [${i + 1}/${variables.length}] parameter "value" is not defined!` }
        }

        // TODO: Optimize group writing for neighboring variables

        /** @type { S7DBStructure[] } */
        const write_requests = []
        for (let k = 0; k < variables.length; k++) {
            const { name, value } = variables[k]
            let found = false
            for (let i = 0; i < datablocks.length && !found; i++) {
                const { db, items } = datablocks[i]
                for (let j = 0; j < items.length && !found; j++) {
                    const item = items[j]
                    if (name === item.name) {
                        const offset = +(item.offset || 0)
                        const new_item = { ...item, value, offset: 0 }
                        const datablock = { name: datablocks[i].name, db, offset, items: [new_item] }
                        write_requests.push(datablock)
                        found = true
                    }
                }
            }
        }
        if (write_requests.length === 0) return
        return await writePLC({ config, datablocks: write_requests })
    }
    const read = async (...variables) => {
        if (variables.length === 0) return { error: 'No values given!' }
        variables = variables.length > 1 ? variables : variables[0]
        variables = Array.isArray(variables) ? variables : [variables]
        for (let i = 0; i < variables.length; i++) {
            if (typeof variables[i] !== 'object') return { error: `Variable [${i + 1}/${variables.length}] is not an object!` }
            const { name } = variables[i]
            if (!name) return { error: `Variable [${i + 1}/${variables.length}] parameter "name" is not defined!` }
        }
        /** @type { S7DBStructure[] } */
        const read_requests = []
        variables.forEach(({ name }) => {
            for (let i = 0; i < datablocks.length; i++) {
                const { db, items } = datablocks[i]
                for (let j = 0; j < items.length; j++) {
                    const item = items[j]
                    if (name === item.name) {
                        const output = {
                            name: datablocks[i].name,
                            db,
                            offset: item.offset ? +item.offset || 0 : 0,
                            items: [item]
                        }
                        read_requests.push(output)
                        return
                    }
                }
            }
        })
        if (read_requests.length === 0) return
        return await readPLC({ config, datablocks: read_requests })
    }
    const readAll = async () => {
        const results = await readPLC({ config, datablocks })
        return results
    }

    const readAllObject = async () => {
        const results = await readAll()
        return block2object(results)
    }

    const writeObject = async (object) => {
        const block = object2block(object)
        return await write(block)
    }

    /** @type {{ read: read, write: write, readAll: readAll, readAllObject: readAllObject, writeObject: writeObject }} */
    const output = { read, write, readAll, readAllObject, writeObject }
    return output
}

/** @typedef */
const output = {
    PLC_handler,
    getS7Data,
    readPLC,
    setS7Data,
    writePLC,
}

module.exports = output
