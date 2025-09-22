// Add this to your DynamoClient (add the scanItems method and expose docClient):

const { 
  DynamoDBClient
} = require("@aws-sdk/client-dynamodb")
  
const { 
  DynamoDBDocumentClient, 
  DeleteCommand, 
  GetCommand, 
  PutCommand,
  QueryCommand,
  UpdateCommand,
  ScanCommand  // Add this import
} = require("@aws-sdk/lib-dynamodb")

const credentials = { 
  accessKeyId:process.env.DYNACC_KEY_ID,
  secretAccessKey:process.env.DYNACC_SEC_ID
}
const dynamodb = new DynamoDBClient({region: 'us-east-1', credentials});
const docClient = DynamoDBDocumentClient.from(dynamodb);

const DynamoClient = {
  
  // Expose the docClient for direct access if needed
  docClient,

  async addItem(params) {
    console.log(params)
    const command = new PutCommand(params)
    try {
      const response = await docClient.send(command)
      return response
    } catch (e){
      console.log(e)
      return false
    }
  },

  async getItem (params) {
    const command = new GetCommand(params)
    try {
      const response = await docClient.send(command)
      return response
    } catch (e) {
      console.log(e)
      return e
    }
  },

  async queryItems (params) {
    const command = new QueryCommand(params)
    try {
      const response = await docClient.send(command)
      return response
    } catch (e) {
      console.log(e)
      return e
    }
  },

  // Add the missing scanItems method
  async scanItems (params) {
    const command = new ScanCommand(params)
    try {
      const response = await docClient.send(command)
      return response
    } catch (e) {
      console.log(e)
      return e
    }
  },

  async updateItem (params) {
    const command = new UpdateCommand(params)
    try {
      const response = await docClient.send(command)
      console.log(response)
      return response
    } catch (e){
      return false
    }
  },

  async removeItem (params) {
    const command = new DeleteCommand(params)
    try {
      const response = await docClient.send(command)
      return response
    } catch (e){
      console.log(e)
      return false
    }
  }
  
}

module.exports = DynamoClient
