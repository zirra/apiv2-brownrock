require('dotenv').config();
const { Contact } = require('./config/pddbclient.cjs');

(async () => {
  console.log('🔍 Checking specific addresses...\n');
  
  const contact = await Contact.findOne({
    where: { address: 'One Lincoln Center' },
    attributes: ['id', 'name', 'address', 'city', 'state', 'zip']
  });
  
  if (contact) {
    console.log('✅ Found cleaned "One Lincoln Center" address:');
    console.log(`  ID: ${contact.id}`);
    console.log(`  Name: ${contact.name}`);
    console.log(`  Address: ${contact.address}`);
    console.log(`  City: ${contact.city}`);
    console.log(`  State: ${contact.state}`);
    console.log(`  ZIP: ${contact.zip}`);
  } else {
    console.log('Address "One Lincoln Center" not found (might have been different text)');
  }
  
  process.exit(0);
})();
