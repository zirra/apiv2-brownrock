require('dotenv').config();
const PostgresContactService = require('../services/postgres-contact.service.js');

(async () => {
  try {
    const service = new PostgresContactService();

    console.log('🚀 Starting migration of ALL contacts to contactsready...\n');

    let totalMoved = 0;
    let totalSkipped = 0;
    let totalFailed = 0;
    let totalProcessed = 0;
    let offset = 0;
    const batchSize = 1000;
    let hasMore = true;

    while (hasMore) {
      console.log(`\n🔄 Processing batch starting at offset ${offset}...`);

      const result = await service.moveContactsToReady({
        limit: batchSize,
        offset
      });

      if (!result.success) {
        console.error(`❌ Batch failed at offset ${offset}:`, result.error);
        break;
      }

      totalMoved += result.moved;
      totalSkipped += result.skipped;
      totalFailed += result.failed;
      totalProcessed += result.processed;

      // If we got fewer contacts than the batch size, we're done
      if (result.processed < batchSize) {
        hasMore = false;
      } else {
        offset += batchSize;
      }
    }

    console.log('\n' + '='.repeat(80));
    console.log('📊 COMPLETE MIGRATION SUMMARY');
    console.log('='.repeat(80));
    console.log(`Total processed: ${totalProcessed}`);
    console.log(`✅ Successfully moved: ${totalMoved}`);
    console.log(`⏭️ Skipped (duplicates): ${totalSkipped}`);
    console.log(`❌ Failed: ${totalFailed}`);
    console.log('='.repeat(80) + '\n');

    console.log('✅ Migration complete!');
    process.exit(0);

  } catch (error) {
    console.error('❌ Migration failed:', error);
    process.exit(1);
  }
})();
