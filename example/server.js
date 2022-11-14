// @ts-check
"use strict"

const snap7 = require('node-snap7') // @ts-ignore
const s7server = new snap7.S7Server()

// Set up event listener
s7server.on("event", function (event) {
    console.log(s7server.EventText(event))
})

// Create a new Buffer and register it to the server as DB1
const DB1_buffer = Buffer.alloc(1024)
s7server.RegisterArea(s7server.srvAreaDB, 1, DB1_buffer)

// Start the server
s7server.StartTo('127.0.0.1', () => {
    console.log(`S7 server running`)
})

// On unexpected exit, trace what happened
process.on('uncaughtException', function (err) {
    console.log('Caught exception: ' + err)
})
process.on('unhandledRejection', function (err) {
    console.log('Caught rejection: ' + err)
})
