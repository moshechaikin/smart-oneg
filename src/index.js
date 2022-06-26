'use strict';

const { Telnet } = require('telnet-client');

process.on('unhandledRejection', error => {
    throw error
});

async function run() {
    let connection = new Telnet();

    let params = {
        host: '192.168.0.190',
        port: 23,
        shellPrompt: 'GNET>',
        timeout: 2000,
        username: 'lutron',
        password: 'integration'
    };

    let cmd = 'output,2,1,70';

    try {
        await connection.connect(params);
    } catch (error) {
        // handle the throw (timeout)
        console.log(error)
    }

    connection.on('data', function (data) {
        console.log("DATA: " + data);
    })


    await connection.exec(`#${cmd}`);
    await connection.exec(`~output,2,1`);
    // await connection.nextData().then(console.log);
}

run()