const { DataTypes, Model } = require('sequelize');

class Contact extends Model {
  static init(sequelize) {
    return super.init({
      id: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true
      },
      name: {
        type: DataTypes.STRING(255),
        allowNull: true,
        validate: {
          len: [0, 255]
        }
      },
      llc_owner: {
        type: DataTypes.STRING(255),
        allowNull: true,
        validate: {
          len: [0, 255]
        }
      },
      possible_relative: {
        type: DataTypes.STRING(255),
        allowNull: true,
        validate: {
          len: [0, 255]
        }
      },
      deceased_relative: {
        type: DataTypes.STRING(255),
        allowNull: true,
        validate: {
          len: [0, 255]
        }
      },
      phone1: {
        type: DataTypes.STRING(20),
        allowNull: true,
        validate: {
          len: [0, 20],
          isPhoneNumber(value) {
            if (value && !/^[\d\s\-\(\)\+\.]*$/.test(value)) {
              throw new Error('Phone number contains invalid characters');
            }
          }
        }
      },
      phone2: {
        type: DataTypes.STRING(20),
        allowNull: true,
        validate: {
          len: [0, 20],
          isPhoneNumber(value) {
            if (value && !/^[\d\s\-\(\)\+\.]*$/.test(value)) {
              throw new Error('Phone number contains invalid characters');
            }
          }
        }
      },
      phone3: {
        type: DataTypes.STRING(20),
        allowNull: true,
        validate: {
          len: [0, 20],
          isPhoneNumber(value) {
            if (value && !/^[\d\s\-\(\)\+\.]*$/.test(value)) {
              throw new Error('Phone number contains invalid characters');
            }
          }
        }
      },
      phone4: {
        type: DataTypes.STRING(20),
        allowNull: true,
        validate: {
          len: [0, 20],
          isPhoneNumber(value) {
            if (value && !/^[\d\s\-\(\)\+\.]*$/.test(value)) {
              throw new Error('Phone number contains invalid characters');
            }
          }
        }
      },
      phone5: {
        type: DataTypes.STRING(20),
        allowNull: true,
        validate: {
          len: [0, 20],
          isPhoneNumber(value) {
            if (value && !/^[\d\s\-\(\)\+\.]*$/.test(value)) {
              throw new Error('Phone number contains invalid characters');
            }
          }
        }
      },
      phone6: {
        type: DataTypes.STRING(20),
        allowNull: true,
        validate: {
          len: [0, 20],
          isPhoneNumber(value) {
            if (value && !/^[\d\s\-\(\)\+\.]*$/.test(value)) {
              throw new Error('Phone number contains invalid characters');
            }
          }
        }
      },
      phone7: {
        type: DataTypes.STRING(20),
        allowNull: true,
        validate: {
          len: [0, 20],
          isPhoneNumber(value) {
            if (value && !/^[\d\s\-\(\)\+\.]*$/.test(value)) {
              throw new Error('Phone number contains invalid characters');
            }
          }
        }
      },
      phone8: {
        type: DataTypes.STRING(20),
        allowNull: true,
        validate: {
          len: [0, 20],
          isPhoneNumber(value) {
            if (value && !/^[\d\s\-\(\)\+\.]*$/.test(value)) {
              throw new Error('Phone number contains invalid characters');
            }
          }
        }
      },
      email1: {
        type: DataTypes.STRING(255),
        allowNull: true,
        validate: {
          isEmail: true,
          len: [0, 255]
        }
      },
      email2: {
        type: DataTypes.STRING(255),
        allowNull: true,
        validate: {
          isEmail: true,
          len: [0, 255]
        }
      },
      address: {
        type: DataTypes.TEXT,
        allowNull: true
      },
      city: {
        type: DataTypes.STRING(100),
        allowNull: true,
        validate: {
          len: [0, 100]
        }
      },
      state: {
        type: DataTypes.STRING(50),
        allowNull: true,
        validate: {
          len: [0, 50]
        }
      },
      zip: {
        type: DataTypes.STRING(10),
        allowNull: true,
        validate: {
          len: [0, 10],
          isZipCode(value) {
            if (value && !/^\d{5}(-\d{4})?$/.test(value)) {
              throw new Error('Invalid ZIP code format');
            }
          }
        }
      },
      unit: {
        type: DataTypes.STRING(50),
        allowNull: true,
        validate: {
          len: [0, 50]
        }
      },
      acknowledged: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: false
      },
      islegal: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: false
      }
    }, {
      sequelize,
      modelName: 'Contact',
      tableName: 'contacts',
      timestamps: true,
      underscored: true,
      createdAt: 'created_at',
      updatedAt: 'updated_at',
      indexes: [
        {
          fields: ['name']
        },
        {
          fields: ['phone1']
        },
        {
          fields: ['email1']
        },
        {
          fields: ['city', 'state']
        },
        {
          fields: ['acknowledged']
        },
        {
          fields: ['islegal']
        }
      ]
    });
  }

  // Instance methods
  getFullAddress() {
    const parts = [this.address, this.unit, this.city, this.state, this.zip].filter(Boolean);
    return parts.join(', ');
  }

  getAllPhones() {
    return [this.phone1, this.phone2, this.phone3, this.phone4, this.phone5, this.phone6, this.phone7, this.phone8]
      .filter(Boolean);
  }

  getAllEmails() {
    return [this.email1, this.email2].filter(Boolean);
  }

  // Static methods
  static async findByName(name) {
    return this.findAll({
      where: {
        name: {
          [sequelize.Op.iLike]: `%${name}%`
        }
      }
    });
  }

  static async findByPhone(phone) {
    const { Op } = require('sequelize');
    return this.findAll({
      where: {
        [Op.or]: [
          { phone1: phone },
          { phone2: phone },
          { phone3: phone },
          { phone4: phone },
          { phone5: phone },
          { phone6: phone },
          { phone7: phone },
          { phone8: phone }
        ]
      }
    });
  }

  static async findByEmail(email) {
    const { Op } = require('sequelize');
    return this.findAll({
      where: {
        [Op.or]: [
          { email1: email },
          { email2: email }
        ]
      }
    });
  }

  static async findByLocation(city, state) {
    const { Op } = require('sequelize');
    const whereClause = {};
    
    if (city) {
      whereClause.city = {
        [Op.iLike]: `%${city}%`
      };
    }
    
    if (state) {
      whereClause.state = {
        [Op.iLike]: `%${state}%`
      };
    }

    return this.findAll({ where: whereClause });
  }

  static async findAcknowledged() {
    return this.findAll({
      where: {
        acknowledged: true
      }
    });
  }

  static async findUnacknowledged() {
    return this.findAll({
      where: {
        acknowledged: false
      }
    });
  }

  static async findLegal() {
    return this.findAll({
      where: {
        islegal: true
      }
    });
  }

  static async findNonLegal() {
    return this.findAll({
      where: {
        islegal: false
      }
    });
  }

  static async findPendingReview() {
    return this.findAll({
      where: {
        acknowledged: false,
        islegal: false
      }
    });
  }

  // Bulk operations
  static async bulkCreateContacts(contactsData, options = {}) {
    return this.bulkCreate(contactsData, {
      ignoreDuplicates: true,
      returning: true,
      ...options
    });
  }

  // Data cleaning methods
  static cleanPhoneNumber(phone) {
    if (!phone) return null;
    // Remove all non-digit characters except +
    return phone.replace(/[^\d\+]/g, '');
  }

  static normalizeEmail(email) {
    if (!email) return null;
    return email.toLowerCase().trim();
  }

  // Validation helpers
  static validateContactData(data) {
    const errors = [];
    
    if (data.email1 && !this.isValidEmail(data.email1)) {
      errors.push('email1 is not a valid email address');
    }
    
    if (data.email2 && !this.isValidEmail(data.email2)) {
      errors.push('email2 is not a valid email address');
    }
    
    if (data.zip && !this.isValidZip(data.zip)) {
      errors.push('zip is not a valid ZIP code');
    }
    
    return errors;
  }

  static isValidEmail(email) {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return emailRegex.test(email);
  }

  static isValidZip(zip) {
    const zipRegex = /^\d{5}(-\d{4})?$/;
    return zipRegex.test(zip);
  }
}

module.exports = Contact;