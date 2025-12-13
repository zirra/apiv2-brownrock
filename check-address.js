require('dotenv').config();
const { Contact } = require('./config/pddbclient.cjs');
const { Op } = require('sequelize');

(async () => {
  console.log('🔍 Checking cleaned addresses...\n');
  
  // Check for addresses that previously had "Suite" or commas
  const samples = await Contact.findAll({
    where: {
      [Op.or]: [
        { address: { [Op.like]: '%Lincoln Center%' } },
        { address: { [Op.like]: '%Maple%' } }
      ]
    },
    attributes: ['id', 'name', 'address', 'city', 'state', 'zip'],
    limit: 3
  });
  
  if (samples.length > 0) {
    samples.forEach(contact => {
      console.log(`ID ${contact.id}: ${contact.name}`);
      console.log(`  Address: ${contact.address}`);
      console.log(`  City: ${contact.city}, State: ${contact.state}, ZIP: ${contact.zip}`);
      console.log('');
    });
  } else {
    console.log('No matching addresses found');
  }
  
  process.exit(0);
})();
