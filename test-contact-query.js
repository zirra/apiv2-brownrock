require('dotenv').config();
const { Contact } = require('./config/pddbclient.cjs');
const { Op } = require('sequelize');

async function testQuery() {
  try {
    console.log('Testing contact query...\n');

    // First, let's see ANY contacts with all fields
    const anyComplete = await Contact.findAll({
      where: {
        first_name: { [Op.ne]: null },
        last_name: { [Op.ne]: null },
        address: { [Op.ne]: null },
        city: { [Op.ne]: null },
        state: { [Op.ne]: null },
        zip: { [Op.ne]: null }
      },
      limit: 5,
      order: [['created_at', 'DESC']]
    });

    console.log(`Found ${anyComplete.length} contacts with ALL fields populated:\n`);
    anyComplete.forEach(c => {
      console.log(`ID: ${c.id}`);
      console.log(`Name: ${c.first_name} ${c.last_name}`);
      console.log(`Address: ${c.address}`);
      console.log(`City: ${c.city}`);
      console.log(`State: ${c.state} (length: ${c.state ? c.state.length : 0})`);
      console.log(`ZIP: ${c.zip}`);
      console.log(`State matches 2-letter: ${c.state && c.state.match(/^[A-Z]{2}$/) ? 'YES' : 'NO'}`);
      console.log('---\n');
    });

    // Now test with state regex
    const withStateCheck = await Contact.findAll({
      where: {
        [Op.and]: [
          { first_name: { [Op.ne]: null } },
          { last_name: { [Op.ne]: null } },
          { address: { [Op.ne]: null } },
          { city: { [Op.ne]: null } },
          { state: { [Op.ne]: null } },
          { zip: { [Op.ne]: null } },
          { state: { [Op.regexp]: '^[A-Z]{2}$' } }
        ]
      },
      limit: 5,
      order: [['created_at', 'DESC']]
    });

    console.log(`\nFound ${withStateCheck.length} contacts with 2-letter state codes:\n`);
    withStateCheck.forEach(c => {
      console.log(`ID: ${c.id} | ${c.first_name} ${c.last_name} | ${c.address} | ${c.city}, ${c.state} ${c.zip}`);
    });

    process.exit(0);
  } catch (error) {
    console.error('Error:', error);
    process.exit(1);
  }
}

testQuery();
