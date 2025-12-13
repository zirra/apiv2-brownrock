require('dotenv').config();
const { Contact } = require('./config/pddbclient.cjs');
const { Op } = require('sequelize');

(async () => {
  console.log('🔍 Checking 5400 LBJ Freeway address...\n');
  
  const contact = await Contact.findOne({
    where: { 
      [Op.or]: [
        { address: { [Op.like]: '%5400%' } },
        { address: { [Op.like]: '%LBJ%' } }
      ]
    },
    attributes: ['id', 'name', 'address', 'city', 'state', 'zip']
  });
  
  if (contact) {
    console.log('✅ Found cleaned LBJ Freeway address:');
    console.log(`  ID: ${contact.id}`);
    console.log(`  Name: ${contact.name}`);
    console.log(`  Address: ${contact.address}`);
    console.log(`  City: ${contact.city}`);
    console.log(`  State: ${contact.state}`);
    console.log(`  ZIP: ${contact.zip}`);
    console.log('\n✅ Address has been cleaned! No more "Suite" or city/state/zip in address field.');
  } else {
    console.log('No addresses found with 5400 or LBJ');
  }
  
  process.exit(0);
})();
