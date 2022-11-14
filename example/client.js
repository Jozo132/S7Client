// @ts-check
"use strict"

const s7 = require('../index.js')

const { PLC_handler } = s7

const local_s7 = PLC_handler({
    config: {
        host: '127.0.0.1' // PLC Address
    },
    datablocks: [
        {
            db: 1, // PLC DataBlock number
            offset: 0, // DataBlock starting offset
            items: [
                { name: 'BYTE_number', type: 'BYTE' },
                { name: 'USINT_number', type: 'USINT' },
                { name: 'SINT_number', type: 'SINT' },
                { name: 'UINT_number', type: 'UINT' },
                { name: 'INT_number', type: 'INT' },
                { name: 'UDINT_number', type: 'UDINT' },
                { name: 'DINT_number', type: 'DINT' },
                { name: 'REAL_number', type: 'REAL' },
                { name: 'WORD_number', type: 'WORD' },
                { name: 'DWORD_number', type: 'DWORD' },
                { name: 'STRING_text', type: 'STRING' },
                { name: 'STRING_16_text', type: 'STRING', strlen: 16 },
                { name: 'S5TIME_number', type: 'S5TIME' },
            ]
        }
    ]
})


const main = async () => {
    // Read all items from PLC datablock structure
    const result = await local_s7.readAllObject()
    console.log(`Result: `, result)

    // Maniuplate the data
    result.BYTE_number++
    result.USINT_number++
    result.SINT_number--
    result.UINT_number++
    result.INT_number--
    result.UDINT_number++
    result.DINT_number--
    result.REAL_number += 0.1
    result.WORD_number++
    result.DWORD_number++
    result.STRING_text = 'This is a long message which will most likely not fit the 16 bytes allocated version of the string'
    result.STRING_16_text = 'This is a long message which will most likely not fit the 16 bytes allocated version of the string'
    result.S5TIME_number += 100

    // Write the manipulated data back to the PLC
    await local_s7.writeObject(result)

    // Read all the items again from PLC datablock structure
    const result2 = await local_s7.readAllObject()
    console.log(`Result: `, result2)
}

main().catch(console.error).finally(() => process.exit(0))