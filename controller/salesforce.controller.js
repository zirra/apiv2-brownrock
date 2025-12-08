require("dotenv").config()

class SalesForce{
  constructor() {
    console.log('🔍 Salesforce initialized');
  }
}

// Create single instance
const salesForce = new SalesForce()

// Export controller for routes
module.exports.Controller = { SalesForce: salesForce };
module.exports.controller = (app) => {
  console.log('🔍 Loading Salesforce controller routes...');
  console.log('✅ SalesForce controller routes loaded successfully');
};