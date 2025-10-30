require('dotenv').config()
const axios = require('axios')

class DataService {
  constructor(authService, loggingService) {
    this.authService = authService
    this.loggingService = loggingService
    this.applicantNames = ['Cimarex', 'Mewbourne', 'Tap Rock', 'Permian Resources', 'Marathon', 'Devon', 'Matador']
    this.countyNames = ['Eddy', 'Lea']
  }

  async callForData(applicantName) {
    const now = new Date();
    // 7 days in milliseconds
    const sevenDays = 7 * 24 * 60 * 60 * 1000;
    // Date from 7 days ago
    const sevenDaysAgo = new Date(Date.now() - sevenDays);
    // Extract month & day from 7 days ago
    const month = sevenDaysAgo.getMonth() + 1; // months are 0-based
    const day = sevenDaysAgo.getDate();
    // Use the current year
    const year = now.getFullYear();
    
    let url = `OCD/Imaging/Case/Files/Search/25/1?ApplicantName=${applicantName}&ApplicantNameFilterExpression=Contains&ScanDate=${month}%2F${day}%2F${year}&ScanDateFilterExpression=GreaterThan`
    
    const token = this.authService.getToken()
    if (!token) {
      console.warn('No token. Attempting login...')
      await this.authService.login()
    }
    
    try {
      const response = await axios.get(`https://api.emnrd.nm.gov/wda/v1/${url}`, {
        headers: {
          Authorization: `Bearer ${this.authService.getToken()}`
        }
      })
      return response
    } catch (error) {
      if (error.response?.status === 401) {
        console.warn('Token expired. Logging in again...')
        await this.authService.login()
        return await this.callForData(applicantName)
      }
      console.error('Data fetch failed:', error.message)
      await this.loggingService.writeMessage('dataError', error.message)
    }
  }

  getApplicantNames() {
    return this.applicantNames
  }

  async callForDataByCounty(countyName) {
    const now = new Date();
    // 7 days in milliseconds
    const sevenDays = 7 * 24 * 60 * 60 * 1000;
    // Date from 7 days ago
    const sevenDaysAgo = new Date(Date.now() - sevenDays);
    // Extract month & day from 7 days ago
    const month = sevenDaysAgo.getMonth() + 1; // months are 0-based
    const day = sevenDaysAgo.getDate();
    // Use the current year
    const year = now.getFullYear();

    let url =`OCD/Imaging/AdministrativeOrder/Files/Search/25/1?CountyName=${countyName}&ScanDate=${month}%2F${day}%2F${year}&ScanDateFilterExpression=GreaterThan`

    console.log(`URL being called: ${url} <----------`)
    /*
    let url = `OCD/Imaging/Case/Files/Search/25/1?County=${countyName}&CountyFilterExpression=Contains&ScanDate=${month}%2F${day}%2F${year}&ScanDateFilterExpression=GreaterThan`
    */

    const token = this.authService.getToken()
    if (!token) {
      console.warn('No token. Attempting login...')
      await this.authService.login()
    }

    try {
      const response = await axios.get(`https://api.emnrd.nm.gov/wda/v1/${url}`, {
        headers: {
          Authorization: `Bearer ${this.authService.getToken()}`
        }
      })
      return response
    } catch (error) {
      if (error.response?.status === 401) {
        console.warn('Token expired. Logging in again...')
        await this.authService.login()
        return await this.callForDataByCounty(countyName)
      }
      console.error('Data fetch failed:', error.message)
      await this.loggingService.writeMessage('dataError', error.message)
    }
  }

  getCountyNames() {
    return this.countyNames
  }
}

module.exports = DataService