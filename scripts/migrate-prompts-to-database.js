require('dotenv').config();
const { ExtractionPrompt, ExtractionPromptVersion } = require('../config/pddbclient.cjs');
const extractionPromptsJS = require('../prompts/extraction-prompts.js');

/**
 * Migration Script: Import Extraction Prompts to Database
 *
 * This script imports all prompts from prompts/extraction-prompts.js into the database
 * Run with: node scripts/migrate-prompts-to-database.js [--dry-run]
 */

// Mapping of prompt keys to metadata
const promptMetadata = {
  'oil-gas-contacts': {
    name: 'Oil & Gas Contact Extraction',
    description: 'Extracts contact information from oil & gas documents including pooling orders, unit declarations, and ownership records. Handles postal delivery reports, parties to pool sections, and ownership tables.',
    document_types: ['oil-gas', 'pooling-orders', 'unit-declarations'],
    project_origins: ['OCD_IMAGING'],
    is_default: true
  },
  'oil-gas-contacts-old': {
    name: 'Oil & Gas Contact Extraction (Legacy)',
    description: 'Previous version of oil & gas contact extraction. Kept for reference and rollback.',
    document_types: ['oil-gas'],
    project_origins: ['OCD_IMAGING'],
    is_default: false,
    is_active: false // Legacy version, not active by default
  },
  'ocd-cbt-contacts': {
    name: 'OCD CBT Contact Extraction',
    description: 'Extracts contact information from OCD CBT county-based documents including mailing lists, distribution lists, and certified mail receipts.',
    document_types: ['ocd-cbt', 'county-documents'],
    project_origins: ['OCD_CBT'],
    is_default: true
  },
  'olm-contacts': {
    name: 'OLM Contact Extraction',
    description: 'Extracts contact and ownership information from Oil & Mineral Lease documents including mineral interest owners, working interest owners, and property schedules.',
    document_types: ['olm', 'mineral-lease', 'oil-lease'],
    project_origins: ['OLM'],
    is_default: true
  },
  'plc-contacts': {
    name: 'PLC Contact Extraction',
    description: 'Extracts contact information from Pipeline/Location Certificate documents including surface owners, landowners, pipeline operators, and right-of-way holders.',
    document_types: ['plc', 'pipeline', 'location-certificate'],
    project_origins: ['PLC'],
    is_default: true
  },
  'lease-agreements': {
    name: 'Lease Agreement Extraction',
    description: 'Extracts lease terms and parties from lease agreements including lessors, lessees, royalty percentages, bonus payments, and acreage information.',
    document_types: ['lease-agreement', 'lease-contract'],
    project_origins: ['OLM', 'OCD_IMAGING'],
    is_default: false
  }
};

class PromptMigrator {
  constructor(options = {}) {
    this.dryRun = options.dryRun || false;
    this.stats = {
      total: 0,
      created: 0,
      updated: 0,
      skipped: 0,
      errors: 0
    };
  }

  /**
   * Import a single prompt
   */
  async importPrompt(promptKey, promptContent) {
    try {
      this.stats.total++;

      const metadata = promptMetadata[promptKey] || {
        name: promptKey.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' '),
        description: `Extraction prompt for ${promptKey}`,
        document_types: [promptKey],
        project_origins: [],
        is_default: false
      };

      const promptData = {
        prompt_key: promptKey,
        name: metadata.name,
        description: metadata.description,
        native_prompt: promptContent.native,
        text_prompt: promptContent.text,
        document_types: metadata.document_types,
        project_origins: metadata.project_origins,
        is_active: metadata.is_active !== undefined ? metadata.is_active : true,
        is_default: metadata.is_default || false,
        version: 1,
        created_by: 'system',
        updated_by: 'system'
      };

      if (this.dryRun) {
        console.log(`[DRY RUN] Would import prompt: ${promptKey}`);
        console.log(`  Name: ${promptData.name}`);
        console.log(`  Projects: ${promptData.project_origins.join(', ')}`);
        console.log(`  Document Types: ${promptData.document_types.join(', ')}`);
        console.log(`  Native Prompt Length: ${promptData.native_prompt.length} chars`);
        console.log(`  Text Prompt Length: ${promptData.text_prompt.length} chars`);
        console.log(`  Is Default: ${promptData.is_default}`);
        console.log(`  Is Active: ${promptData.is_active}`);
        this.stats.created++;
        return;
      }

      // Check if prompt already exists
      const existing = await ExtractionPrompt.findOne({
        where: { prompt_key: promptKey }
      });

      if (existing) {
        // Check if content has changed
        const hasChanged =
          existing.native_prompt !== promptData.native_prompt ||
          existing.text_prompt !== promptData.text_prompt;

        if (hasChanged) {
          console.log(`✏️  Updating prompt: ${promptKey} (version ${existing.version} → ${existing.version + 1})`);

          // Create version history before updating
          await ExtractionPromptVersion.create({
            prompt_id: existing.id,
            version: existing.version,
            native_prompt: existing.native_prompt,
            text_prompt: existing.text_prompt,
            changes_summary: 'Migration from extraction-prompts.js',
            created_by: 'system'
          });

          // Update prompt
          await existing.update({
            ...promptData,
            version: existing.version + 1
          });

          this.stats.updated++;
        } else {
          console.log(`⏭️  Skipping (no changes): ${promptKey}`);
          this.stats.skipped++;
        }
      } else {
        console.log(`✨ Creating new prompt: ${promptKey}`);
        await ExtractionPrompt.create(promptData);

        // Create initial version
        const created = await ExtractionPrompt.findOne({
          where: { prompt_key: promptKey }
        });

        await ExtractionPromptVersion.create({
          prompt_id: created.id,
          version: 1,
          native_prompt: created.native_prompt,
          text_prompt: created.text_prompt,
          changes_summary: 'Initial import from extraction-prompts.js',
          created_by: 'system'
        });

        this.stats.created++;
      }

    } catch (error) {
      console.error(`❌ Error importing prompt ${promptKey}: ${error.message}`);
      this.stats.errors++;
    }
  }

  /**
   * Run the migration
   */
  async run() {
    console.log('🚀 Starting extraction prompts migration...\n');
    console.log(`Mode: ${this.dryRun ? 'DRY RUN' : 'LIVE'}\n`);

    const startTime = Date.now();

    // Import all prompts
    for (const [promptKey, promptContent] of Object.entries(extractionPromptsJS)) {
      await this.importPrompt(promptKey, promptContent);
    }

    const duration = ((Date.now() - startTime) / 1000).toFixed(2);

    console.log('\n' + '='.repeat(60));
    console.log('📊 MIGRATION COMPLETE');
    console.log('='.repeat(60));
    console.log(`Total prompts processed: ${this.stats.total}`);
    console.log(`Created: ${this.stats.created}`);
    console.log(`Updated: ${this.stats.updated}`);
    console.log(`Skipped (no changes): ${this.stats.skipped}`);
    console.log(`Errors: ${this.stats.errors}`);
    console.log(`Duration: ${duration}s`);
    console.log('='.repeat(60));

    if (this.dryRun) {
      console.log('\n⚠️  This was a DRY RUN. No changes were made to the database.');
      console.log('Run without --dry-run to apply changes.');
    } else {
      console.log('\n✅ Migration successful! Prompts are now in the database.');
      console.log('You can manage them via the API at /v1/extraction-prompts');
    }
  }
}

// Parse command line arguments
const args = process.argv.slice(2);
const options = {
  dryRun: args.includes('--dry-run')
};

// Run the migrator
(async () => {
  try {
    const migrator = new PromptMigrator(options);
    await migrator.run();
    process.exit(0);
  } catch (error) {
    console.error('❌ Fatal error:', error.message);
    console.error(error.stack);
    process.exit(1);
  }
})();
