const { DataTypes, Model } = require('sequelize');

class WhitepagesLookup extends Model {
  static init(sequelize) {
    return super.init({
      id: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true
      },
      contact_id: {
        type: DataTypes.INTEGER,
        allowNull: false,
        comment: 'Reference to contacts table (not enforced FK for flexibility)'
      },
      // Original search criteria from contact
      search_first_name: {
        type: DataTypes.STRING(255),
        allowNull: true
      },
      search_last_name: {
        type: DataTypes.STRING(255),
        allowNull: true
      },
      search_address: {
        type: DataTypes.TEXT,
        allowNull: true
      },
      search_city: {
        type: DataTypes.STRING(100),
        allowNull: true
      },
      search_state: {
        type: DataTypes.STRING(50),
        allowNull: true
      },
      search_zip: {
        type: DataTypes.STRING(10),
        allowNull: true
      },
      // WhitePages API response data
      wp_person_id: {
        type: DataTypes.STRING(50),
        allowNull: true,
        comment: 'WhitePages unique person ID'
      },
      wp_name: {
        type: DataTypes.STRING(255),
        allowNull: true,
        comment: 'Full name returned from WhitePages'
      },
      wp_aliases: {
        type: DataTypes.JSON,
        allowNull: true,
        comment: 'Array of name aliases'
      },
      wp_is_dead: {
        type: DataTypes.BOOLEAN,
        allowNull: true,
        defaultValue: false
      },
      wp_current_addresses: {
        type: DataTypes.JSON,
        allowNull: true,
        comment: 'Array of current address objects'
      },
      wp_historic_addresses: {
        type: DataTypes.JSON,
        allowNull: true,
        comment: 'Array of historic address objects'
      },
      wp_owned_properties: {
        type: DataTypes.JSON,
        allowNull: true,
        comment: 'Array of owned property objects'
      },
      wp_phones: {
        type: DataTypes.JSON,
        allowNull: true,
        comment: 'Array of phone objects with number, type, score'
      },
      wp_emails: {
        type: DataTypes.JSON,
        allowNull: true,
        comment: 'Array of email addresses'
      },
      wp_date_of_birth: {
        type: DataTypes.STRING(20),
        allowNull: true,
        comment: 'Date of birth (may be partial like 1983-01-00)'
      },
      wp_linkedin_url: {
        type: DataTypes.TEXT,
        allowNull: true
      },
      wp_company_name: {
        type: DataTypes.STRING(255),
        allowNull: true
      },
      wp_job_title: {
        type: DataTypes.STRING(255),
        allowNull: true
      },
      wp_relatives: {
        type: DataTypes.JSON,
        allowNull: true,
        comment: 'Array of relative objects with id and name'
      },
      // Lookup metadata
      lookup_status: {
        type: DataTypes.STRING(20),
        allowNull: false,
        defaultValue: 'pending',
        validate: {
          isIn: [['pending', 'success', 'no_results', 'error']]
        },
        comment: 'Status of the WhitePages lookup'
      },
      lookup_error: {
        type: DataTypes.TEXT,
        allowNull: true,
        comment: 'Error message if lookup failed'
      },
      api_url: {
        type: DataTypes.TEXT,
        allowNull: true,
        comment: 'Full API URL that was called for debugging'
      },
      lookup_at: {
        type: DataTypes.DATE,
        allowNull: true,
        comment: 'Timestamp when lookup was performed'
      },
      // Verification tracking
      verified: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: false,
        comment: 'Has a person verified this lookup result?'
      },
      verified_by: {
        type: DataTypes.STRING(100),
        allowNull: true,
        comment: 'User who verified the result'
      },
      verified_at: {
        type: DataTypes.DATE,
        allowNull: true,
        comment: 'When the result was verified'
      },
      verification_notes: {
        type: DataTypes.TEXT,
        allowNull: true,
        comment: 'Notes from verification process'
      },
      // Raw API response for debugging
      raw_response: {
        type: DataTypes.JSON,
        allowNull: true,
        comment: 'Complete raw API response for reference'
      }
    }, {
      sequelize,
      modelName: 'WhitepagesLookup',
      tableName: 'whitepages_lookups',
      timestamps: true,
      underscored: true,
      indexes: [
        {
          fields: ['contact_id']
        },
        {
          fields: ['lookup_status']
        },
        {
          fields: ['verified']
        },
        {
          fields: ['lookup_at']
        },
        {
          fields: ['wp_person_id']
        },
        {
          fields: ['search_first_name', 'search_last_name']
        }
      ]
    });
  }
}

module.exports = WhitepagesLookup;
