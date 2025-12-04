require('dotenv').config();
const { Contact } = require('./config/pddbclient.cjs');
const { Op } = require('sequelize');

(async () => {
  try {
    console.log('📊 Analyzing address data in contacts table...\n');

    // Get total contacts with addresses
    const totalWithAddress = await Contact.count({
      where: {
        address: { [Op.ne]: null }
      }
    });
    console.log(`Total contacts with address: ${totalWithAddress}`);

    // Sample addresses to identify patterns
    const sampleContacts = await Contact.findAll({
      where: {
        address: { [Op.ne]: null },
        address: { [Op.ne]: '' }
      },
      attributes: ['id', 'first_name', 'last_name', 'address', 'city', 'state', 'zip'],
      limit: 50,
      order: [['created_at', 'DESC']]
    });

    console.log('\n📋 Sample of address formats:\n');

    let needsCleaning = 0;
    let cleanAddresses = 0;

    sampleContacts.forEach(c => {
      const addr = c.address || '';
      const hasComma = addr.includes(',');

      if (hasComma) {
        needsCleaning++;
        const parts = addr.split(',');
        const cleanAddr = parts[0].trim();
        console.log(`❌ NEEDS CLEANING (ID: ${c.id})`);
        console.log(`   Original: "${addr}"`);
        console.log(`   Cleaned:  "${cleanAddr}"`);
        console.log(`   City: ${c.city}, State: ${c.state}, ZIP: ${c.zip}\n`);
      } else {
        cleanAddresses++;
      }
    });

    console.log(`\n📈 Sample Statistics (n=${sampleContacts.length}):`);
    console.log(`   Clean addresses: ${cleanAddresses} (${((cleanAddresses/sampleContacts.length)*100).toFixed(1)}%)`);
    console.log(`   Need cleaning: ${needsCleaning} (${((needsCleaning/sampleContacts.length)*100).toFixed(1)}%)`);

    // Estimate total needing cleanup
    const estimatedNeedingCleanup = Math.round((needsCleaning / sampleContacts.length) * totalWithAddress);
    console.log(`\n🔍 Estimated contacts needing address cleanup: ~${estimatedNeedingCleanup} out of ${totalWithAddress}`);

    // Check for addresses with embedded city/state patterns
    console.log('\n🔎 Checking for common patterns...\n');

    // Pattern 1: Address with comma
    const withComma = await Contact.count({
      where: {
        address: { [Op.like]: '%,%' }
      }
    });
    console.log(`Addresses containing commas: ${withComma}`);

    // Pattern 2: ZIP codes with +4 format
    const withZipPlus4 = await Contact.count({
      where: {
        zip: { [Op.like]: '%-%' }
      }
    });
    console.log(`ZIP codes in ZIP+4 format: ${withZipPlus4}`);

    // Pattern 3: State field issues
    const invalidStateFormat = await Contact.count({
      where: {
        state: { [Op.ne]: null },
        state: { [Op.notRegexp]: '^[A-Z]{2}$' }
      }
    });
    console.log(`State fields not in 2-letter format: ${invalidStateFormat}`);

    console.log('\n✅ Analysis complete');
    process.exit(0);

  } catch (error) {
    console.error('❌ Error:', error.message);
    process.exit(1);
  }
})();
