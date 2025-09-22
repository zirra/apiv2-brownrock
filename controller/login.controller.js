const authenticateJWT = require('../config/authenticate.cjs')
require("dotenv").config()

const { 
  AuthFlowType, 
  CognitoIdentityProviderClient,
  ConfirmSignUpCommand,
  InitiateAuthCommand,
  ResendConfirmationCodeCommand,
  GetUserCommand,
  SignUpCommand } = require("@aws-sdk/client-cognito-identity-provider")
const credentials = { accessKeyId:process.env.ACCESS_KEY_ID }

const jwt = require ('jsonwebtoken')
const short = require('short-uuid')

const hash = process.env.HASH
const ClientId = process.env.CLIENT_ID
const client = new CognitoIdentityProviderClient({region: 'us-east-1', credentials})

const Login = {
  
  async signup (req, res) {
    const { username, password, email } = req.body
    const params = {
      ClientId,
      Username: username,
      Password: password,
      UserAttributes: [{ Name: 'email', Value: email }],
    }
    const command = new SignUpCommand(params)
    try {
      const data = await client.send(command)
      res.json(data)
    } catch (err) {
      console.log(err)
      res.status(400).json(err)
    }
  },

  async signin (req, res) {
    const { username, password } = req.body
    const input = {
      AuthFlow: AuthFlowType.USER_PASSWORD_AUTH,
      ClientId,
      AuthParameters: {
        PASSWORD: password,
        USERNAME: username
      }
    }
    const command = new InitiateAuthCommand(input)
    try {
      const data = await client.send(command)
      const id = data.AuthenticationResult.IdToken
      const rfs = data.AuthenticationResult.RefreshToken
      const token = jwt.sign(
        { 
          username: data.AuthenticationResult.AccessToken
        }, 
        hash, 
        { expiresIn: '8h'}
      )

      const usercommand = new GetUserCommand({ AccessToken: data.AuthenticationResult.AccessToken})
      let user = await client.send(usercommand)
      const em = user.UserAttributes.find((item) => item.Name === "email");
      const sub = user.UserAttributes.find((item) => item.Name === "sub");
      
      const translator = short ()
      let newval = translator.fromUUID(sub.Value)

      res.json({token, id, rfs, email: em.Value, uid: newval})
    } catch (err) {
      console.log(err)
      res.status(400).json(err)
    }
  },

  async confirm (req, res) {
    const { username, confirmationCode } = req.body
    const params = {
      ClientId,
      Username: username,
      ConfirmationCode: confirmationCode
    }
    const command = new ConfirmSignUpCommand(params)
    try {
      const data = await client.send(command)
      res.json(data)
    } catch (err) {
      res.status(400).json(err)
    }
  },

  async resend (req, res) {
    const {username} = req.body
    const params = {
      Username: username, 
      ClientId
    }
    const command = new ResendConfirmationCodeCommand(params)
    try {
      const data = await client.send(command)
      res.send(data)
    } catch (err) {
      res.status(400).json(err)
    }
  },

  async verify (req, res) {
    res.status(200).send('success')
  },

  async refresh (req, res) {
    res.status(200).send('success')
  }

}

module.exports.Controller = { Login }
module.exports.controller = ( app ) => {
  app.post('/v1/sec/signup', Login.signup )
  app.post('/v1/sec/confirm', Login.confirm )
  app.post('/v1/sec/signin', Login.signin )
  app.post('/v1/sec/resend', Login.resend )
  app.get('/v1/sec/verify', authenticateJWT, Login.verify)
  app.get('/v1/sec/refresh',  Login.refresh)
}