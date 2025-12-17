require('dotenv').config()
const axios = require('axios')
const fs = require('fs')
const jwt = require('jsonwebtoken')
const DynamoClient = require('../config/dynamoclient.cjs')

class AuthService {
  constructor() {
    this.accessToken = null
    this.salesforceAccessToken = null
    this.salesforceInstanceUrl = null
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

  async loginSalesforce() {
    try {
      // Read private key from file
      const privateKey = fs.readFileSync(process.env.SALESFORCE_KEY_PATH, 'utf8')

      // Create JWT payload
      const payload = {
        iss: process.env.SALESFORCE_CLIENT_ID,
        sub: process.env.SALESFORCE_USERNAME,
        aud: process.env.SALESFORCE_LOGIN_URL,
        exp: Math.floor(Date.now() / 1000) + 300 // 5 minutes expiry
      }

      // Sign JWT with private key
      const token = jwt.sign(payload, privateKey, { algorithm: 'RS256' })

      // Exchange JWT for access token
      const response = await axios.post(
        `${process.env.SALESFORCE_LOGIN_URL}/services/oauth2/token`,
        new URLSearchParams({
          grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
          assertion: token
        }),
        {
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded'
          }
        }
      )

      this.salesforceAccessToken = response.data.access_token
      this.salesforceInstanceUrl = response.data.instance_url

      await this.writeDynamoMessage({
        pkey: 'salesforce-login#success',
        skey: 'success',
        origin: 'salesforce-login',
        type: 'system',
        data: `Successful Salesforce login for ${process.env.SALESFORCE_USERNAME}`
      })

      return {
        accessToken: this.salesforceAccessToken,
        instanceUrl: this.salesforceInstanceUrl
      }
    } catch (error) {
      await this.writeDynamoMessage({
        pkey: 'salesforce-login#error',
        skey: 'error#message',
        origin: 'salesforce-login',
        type: 'system',
        data: error.message
      })

      console.error('Salesforce authentication error:', error.response?.data || error.message)
      return null
    }
  }

  getSalesforceToken() {
    return this.salesforceAccessToken
  }

  getSalesforceInstanceUrl() {
    return this.salesforceInstanceUrl
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