const fs = require('fs')

class LoggingService {
  constructor() {
    this.logPath = './logs/'
  }

  async writeMessage(name, message) {
    const timestamp = new Date().toISOString()
    const logMessage = `[${timestamp}] ${message}\n`

    fs.appendFile(`${this.logPath}_${timestamp}_${name}.txt`, logMessage, (err) => {
      if (err) {
        console.error('Failed to write to log:', err)
      } else {
        console.log('Log updated.')
      }
    })
  }

  stamp() {
    const today = new Date();
    const month = String(today.getMonth() + 1).padStart(2, '0');
    const day = String(today.getDate()).padStart(2, '0');
    const year = today.getFullYear();
    return `${month}_${day}_${year}`;
  }
}

module.exports = LoggingService