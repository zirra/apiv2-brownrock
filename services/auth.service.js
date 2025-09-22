require('dotenv').config()
const axios = require('axios')
const DynamoClient = require('../config/dynamoclient.cjs')

class AuthService {
  constructor() {
    this.accessToken = null
    this.TableName = process.env.DYNAMO_TABLE
  }

  async login() {
    try {
      const response = await axios.post(`https://api.emnrd.nm.gov/wda/v1/OCD/Imaging/Authorization/Token/LoginCredentials`, {
        username: process.env.EMNRD_USER,
        password: process.env.EMNRD_PASS
      })
      
      this.accessToken = response.data.AccessToken
      
      await this.writeDynamoMessage({ 
        pkey: 'login#success',
        skey: 'success',
        origin: 'login', 
        type:'system', 
        data: 'succesful login'
      })
      
      return this.accessToken
    } catch (error) {
      await this.writeDynamoMessage({ 
        pkey: 'login#error',
        skey: 'error#message',
        origin: 'login', 
        type:'system', 
        data: error.message
      })
      
      return null
    }
  }

  getToken() {
    return this.accessToken
  }

  async writeDynamoMessage(message) {
    const timestamp = new Date().toISOString()
    try {
      let document = await DynamoClient.addItem({
        TableName: this.TableName,
        Item: {
          pkey: `${message.pkey}#${this.stamp()}`,
          skey: message.skey,
          message: `${message.data}`,
          timestamp
        }
      })
      return document
    } catch (e) {
      console.log(e)
      return e
    }
  }

  stamp() {
    const today = new Date();
    const month = String(today.getMonth() + 1).padStart(2, '0');
    const day = String(today.getDate()).padStart(2, '0');
    const year = today.getFullYear();
    return `${month}_${day}_${year}`;
  }
}

module.exports = AuthService