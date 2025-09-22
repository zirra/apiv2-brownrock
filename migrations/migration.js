// migrations/YYYYMMDDHHMMSS-create-contacts.js
'use strict';

module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.createTable('contacts', {
      id: {
        allowNull: false,
        autoIncrement: true,
        primaryKey: true,
        type: Sequelize.INTEGER
      },
      name: {
        type: Sequelize.STRING(255),
        allowNull: true
      },
      llc_owner: {
        type: Sequelize.STRING(255),
        allowNull: true
      },
      possible_relative: {
        type: Sequelize.STRING(255),
        allowNull: true
      },
      deceased_relative: {
        type: Sequelize.STRING(255),
        allowNull: true
      },
      phone1: {
        type: Sequelize.STRING(20),
        allowNull: true
      },
      phone2: {
        type: Sequelize.STRING(20),
        allowNull: true
      },
      phone3: {
        type: Sequelize.STRING(20),
        allowNull: true
      },
      phone4: {
        type: Sequelize.STRING(20),
        allowNull: true
      },
      phone5: {
        type: Sequelize.STRING(20),
        allowNull: true
      },
      phone6: {
        type: Sequelize.STRING(20),
        allowNull: true
      },
      phone7: {
        type: Sequelize.STRING(20),
        allowNull: true
      },
      phone8: {
        type: Sequelize.STRING(20),
        allowNull: true
      },
      email1: {
        type: Sequelize.STRING(255),
        allowNull: true
      },
      email2: {
        type: Sequelize.STRING(255),
        allowNull: true
      },
      address: {
        type: Sequelize.TEXT,
        allowNull: true
      },
      city: {
        type: Sequelize.STRING(100),
        allowNull: true
      },
      state: {
        type: Sequelize.STRING(50),
        allowNull: true
      },
      zip: {
        type: Sequelize.STRING(10),
        allowNull: true
      },
      unit: {
        type: Sequelize.STRING(50),
        allowNull: true
      },
      acknowledged: {
        type: Sequelize.BOOLEAN,
        allowNull: false,
        defaultValue: false
      },
      islegal: {
        type: Sequelize.BOOLEAN,
        allowNull: false,
        defaultValue: false
      },
      created_at: {
        allowNull: false,
        type: Sequelize.DATE,
        defaultValue: Sequelize.literal('CURRENT_TIMESTAMP')
      },
      updated_at: {
        allowNull: false,
        type: Sequelize.DATE,
        defaultValue: Sequelize.literal('CURRENT_TIMESTAMP')
      }
    });

    // Add indexes
    await queryInterface.addIndex('contacts', ['name'], {
      name: 'idx_contacts_name'
    });
    
    await queryInterface.addIndex('contacts', ['phone1'], {
      name: 'idx_contacts_phone1'
    });
    
    await queryInterface.addIndex('contacts', ['email1'], {
      name: 'idx_contacts_email1'
    });
    
    await queryInterface.addIndex('contacts', ['city', 'state'], {
      name: 'idx_contacts_city_state'
    });
    
    await queryInterface.addIndex('contacts', ['acknowledged'], {
      name: 'idx_contacts_acknowledged'
    });
    
    await queryInterface.addIndex('contacts', ['islegal'], {
      name: 'idx_contacts_islegal'
    });
  },

  down: async (queryInterface, Sequelize) => {
    await queryInterface.dropTable('contacts');
  }
};