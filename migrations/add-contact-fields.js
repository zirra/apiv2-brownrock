'use strict';

module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.addColumn('contacts', 'first_name', {
      type: Sequelize.STRING(255),
      allowNull: true
    });

    await queryInterface.addColumn('contacts', 'last_name', {
      type: Sequelize.STRING(255),
      allowNull: true
    });

    await queryInterface.addColumn('contacts', 'notes', {
      type: Sequelize.TEXT,
      allowNull: true
    });

    await queryInterface.addColumn('contacts', 'record_type', {
      type: Sequelize.STRING(100),
      allowNull: true
    });

    await queryInterface.addColumn('contacts', 'document_section', {
      type: Sequelize.STRING(255),
      allowNull: true
    });

    await queryInterface.addColumn('contacts', 'source_file', {
      type: Sequelize.STRING(500),
      allowNull: true
    });

    // Add indexes for commonly searched fields
    await queryInterface.addIndex('contacts', ['first_name'], {
      name: 'idx_contacts_first_name'
    });

    await queryInterface.addIndex('contacts', ['last_name'], {
      name: 'idx_contacts_last_name'
    });

    await queryInterface.addIndex('contacts', ['record_type'], {
      name: 'idx_contacts_record_type'
    });

    await queryInterface.addIndex('contacts', ['source_file'], {
      name: 'idx_contacts_source_file'
    });
  },

  down: async (queryInterface, Sequelize) => {
    await queryInterface.removeIndex('contacts', 'idx_contacts_source_file');
    await queryInterface.removeIndex('contacts', 'idx_contacts_record_type');
    await queryInterface.removeIndex('contacts', 'idx_contacts_last_name');
    await queryInterface.removeIndex('contacts', 'idx_contacts_first_name');

    await queryInterface.removeColumn('contacts', 'source_file');
    await queryInterface.removeColumn('contacts', 'document_section');
    await queryInterface.removeColumn('contacts', 'record_type');
    await queryInterface.removeColumn('contacts', 'notes');
    await queryInterface.removeColumn('contacts', 'last_name');
    await queryInterface.removeColumn('contacts', 'first_name');
  }
};