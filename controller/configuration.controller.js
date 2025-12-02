require('dotenv').config();

class ConfigurationController {
  constructor() {
    console.log('🔍 ConfigurationController initialized');
  }

  async getConfigurationPrompts (req, res) {
    res.status(200).send('success')
  }

}

// Create single instance
const configurationController = new ConfigurationController();

// Export controller for routes
module.exports.Controller = { ConfigurationController: configurationController };
module.exports.controller = (app) => {
  console.log('🔍 Loading ConfigurationController controller routes...');
  app.get('/v1/configurables/eligible', (req, res) => configurationController.getConfigurationPrompts(req, res));
  console.log('✅ ConfigurationController controller routes loaded successfully');
};
