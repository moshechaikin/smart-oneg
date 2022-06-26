const { Telnet } = require('telnet-client')
const connection = new Telnet()

const params = {
    host: '192.168.0.190',
    port: 23,
    shellPrompt: 'GNET>',
    timeout: 1500,
    username: 'lutron',
    password: 'integration'
}

connection.connect(params)
    .then(prompt => {
        connection.exec('#output,2,1,100,2')
            .then(res => {
                connection.exec('?output,2,1')
                console.log('promises result:', res)
            })
    }, error => {
        console.log('promises reject:', error)
    })
    .catch(error => {
        // handle the throw (timeout)
        console.log(error)
    });