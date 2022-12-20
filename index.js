import inquirer from 'inquirer'
import { Octokit } from '@octokit/rest'
import { stringify } from 'csv-stringify/sync'
import { parse } from 'csv-parse/sync'
import chalk from 'chalk'
import * as fs from 'fs'
import * as dotenv from 'dotenv'
dotenv.config()

const octokit = new Octokit({
  auth: process.env.TOKEN
})

let modeSelect = null
let srcSelect = null
let destSelect = null
let viewer = null
let allRepos = []
const teamSelect = []
const repoSelect = []

// Query all available organizations for the authenticated user
;(async () => {
  try {
    const orgPrompt = {
      type: 'list',
      name: 'start',
      choices: ['Start', 'Abort'],
      message: 'Begin the transfer process by retrieving the available organizations'
    }

    console.log(chalk.bgBlue('Welcome to the GitHub Repo Transfer Utility'))

    inquirer.prompt(orgPrompt).then((answers) => {
      if (answers.start === 'Start') {
        getOrgs()
      } else {
        console.log('Aborting...')
      }
    })
  } catch (error) {
    console.error(error)
  }
})()

async function getOrgs() {
  try {
    const allOrgs = []
    let endCursor = null
    const query = `query ($cursorID: String) {
      viewer {
        login
        repositories(ownerAffiliations: OWNER) {
          totalCount
        }
        organizations(first: 100, after: $cursorID) {
          nodes {
            login
            repositories {
              totalCount
            }
          } 
          pageInfo {
            hasNextPage
            endCursor
          }
        }
      }
    }`

    let hasNextPage = true
    let dataJSON = null

    do {
      dataJSON = await octokit.graphql({
        query,
        cursorID: endCursor
      })

      const orgs = dataJSON.viewer.organizations.nodes
      hasNextPage = dataJSON.viewer.organizations.pageInfo.hasNextPage

      viewer = dataJSON.viewer.login

      for (const org of orgs) {
        if (hasNextPage) {
          endCursor = dataJSON.viewer.organizations.pageInfo.endCursor
        } else {
          endCursor = null
        }

        allOrgs.push({ name: org.login + '  REPOS: ' + org.repositories.totalCount, value: org.login })
      }
    } while (hasNextPage)

    allOrgs.sort((a, b) => a.name.localeCompare(b.name))
    allOrgs.unshift({ name: dataJSON.viewer.login + '  REPOS: ' + dataJSON.viewer.repositories.totalCount + ' (Personal Account)', value: dataJSON.viewer.login })

    await selectOrg(allOrgs)
  } catch (error) {
    if (error.status === 401) {
      console.log('Unauthorized, please check your token and try again')
    } else {
      console.error(error)
    }
  }
}

// Select source and destination organizations
async function selectOrg(allOrgs) {
  try {
    const sourcePrompt = {
      type: 'list',
      name: 'sourceOrg',
      message: 'Select a source organization to transfer repositories from:',
      choices: allOrgs
    }
    const destPrompt = {
      type: 'list',
      name: 'destOrg',
      message: 'Select a destination organization to transfer repositories to:',
      choices: allOrgs
    }

    inquirer
      .prompt(sourcePrompt)
      .then((answers) => {
        srcSelect = answers.sourceOrg
      })
      .then(() => {
        inquirer
          .prompt(destPrompt)
          .then((answers) => {
            destSelect = answers.destOrg
          })
          .then(() => {
            if (srcSelect === destSelect) {
              console.log('Source and destination organizations cannot be the same, aborting...')
              process.exit()
            } else {
              if (srcSelect === viewer) {
                getPersonalRepos()
              } else {
                getOrgRepos()
              }
            }
          })
      })
  } catch (error) {
    console.error(error)
  }
}

// Retrieve repositories from personal account
async function getPersonalRepos() {
  try {
    let endCursor = null
    const query = /* GraphQL */ `
      query ($owner: String!, $cursorID: String) {
        user(login: $owner) {
          repositories(first: 100, after: $cursorID, ownerAffiliations: OWNER) {
            pageInfo {
              hasNextPage
              endCursor
            }
            nodes {
              name
            }
          }
        }
      }
    `
    let hasNextPage = false
    let dataJSON = null

    do {
      dataJSON = await octokit.graphql({
        query,
        owner: srcSelect,
        cursorID: endCursor
      })

      const repos = dataJSON.user.repositories.nodes
      hasNextPage = dataJSON.user.repositories.pageInfo.hasNextPage

      for (const repo of repos) {
        allRepos.push(repo.name)
      }

      if (hasNextPage) {
        endCursor = dataJSON.user.repositories.pageInfo.endCursor
      } else {
        endCursor = null
      }
    } while (hasNextPage)
    allRepos.sort((a, b) => a.localeCompare(b))
    await selectRepos()
  } catch (error) {
    console.error(error)
  }
}

// Retrieve repositories from source organization and select repositories to transfer
async function getOrgRepos() {
  try {
    let endCursor = null
    const query = /* GraphQL */ `
      query ($owner: String!, $cursorID: String) {
        organization(login: $owner) {
          repositories(first: 100, after: $cursorID) {
            pageInfo {
              hasNextPage
              endCursor
            }
            nodes {
              name
            }
          }
        }
      }
    `
    let hasNextPage = false
    let dataJSON = null

    do {
      dataJSON = await octokit.graphql({
        query,
        owner: srcSelect,
        cursorID: endCursor
      })

      const repos = dataJSON.organization.repositories.nodes
      hasNextPage = dataJSON.organization.repositories.pageInfo.hasNextPage

      for (const repo of repos) {
        if (hasNextPage) {
          endCursor = dataJSON.organization.repositories.pageInfo.endCursor
        } else {
          endCursor = null
        }

        allRepos.push(repo.name)
      }
    } while (hasNextPage)
    allRepos.sort((a, b) => a.localeCompare(b))
    await selectRepos()
  } catch (error) {
    console.error(error)
  }
}

// Select repositories to transfer
async function selectRepos() {
  try {
    const manualPrompt = {
      type: 'list',
      name: 'manual',
      message: 'Choose your transfer method',
      choices: ['Use the interactive transfer wizard', 'Manually edit a generated CSV file']
    }

    const repoPrompt = {
      type: 'checkbox',
      name: 'repos',
      message: 'Select repositories to transfer',
      choices: allRepos
    }

    inquirer
      .prompt(manualPrompt)
      .then((answers) => {
        modeSelect = answers.manual
        if (modeSelect === 'Use the interactive transfer wizard') {
          inquirer.prompt(repoPrompt).then((answers) => {
            for (const repo of answers.repos) {
              repoSelect.push(repo)
            }
            const totalSelected = repoSelect.length
            const totalAvailable = allRepos.length

            console.log(chalk.bgBlue(`You have selected ${totalSelected} repositories out of ${totalAvailable} available repositories`))
            getTeamIds()
          })
        } else {
          getTeamIds()
        }
      })
      .catch((error) => {
        console.error(error)
      })
  } catch (error) {
    console.error(error)
  }
}

// Query for available teams of destination organization and select teams
async function getTeamIds() {
  try {
    if (destSelect !== viewer) {
      const allTeams = []
      let endCursor = null
      const query = /* GraphQL */ `
        query ($owner: String!, $cursorID: String) {
          organization(login: $owner) {
            teams(first: 100, after: $cursorID) {
              nodes {
                databaseId
                name
              }
              pageInfo {
                hasNextPage
                endCursor
              }
            }
          }
        }
      `
      let hasNextPage = false
      let dataJSON = null
      do {
        dataJSON = await octokit.graphql({
          query,
          owner: destSelect,
          cursorID: endCursor
        })

        const teams = dataJSON.organization.teams.nodes

        hasNextPage = dataJSON.organization.teams.pageInfo.hasNextPage

        for (const team of teams) {
          if (hasNextPage) {
            endCursor = dataJSON.organization.teams.pageInfo.endCursor
          } else {
            endCursor = null
          }

          allTeams.push({ name: team.name + '  ID: ' + team.databaseId, value: team.databaseId })
        }
      } while (hasNextPage)

      const teamPrompt = {
        type: 'checkbox',
        name: 'teams',
        message: 'Select the destination organization teams you want to assign to the to be transferred repositories',
        choices: allTeams
      }

      inquirer.prompt(teamPrompt).then((answers) => {
        for (const team of answers.teams) {
          teamSelect.push(team)
        }

        inquirer
          .prompt([
            {
              type: 'confirm',
              name: 'confirm',
              message: `Press confirm to continue or abort to quit`
            }
          ])
          .then((answers) => {
            if (answers.confirm) {
              if (modeSelect === 'Use the interactive transfer wizard') {
                confirmTransfer()
              } else {
                generateCSV()
              }
            } else {
              console.log('Aborting...')
            }
          })
      })
    } else {
      if (modeSelect === 'Use the interactive transfer wizard') {
        confirmTransfer()
      } else {
        generateCSV()
      }
    }
  } catch (err) {
    console.error(err.message)
  }
}

// Confirm repository transfer
async function confirmTransfer() {
  const total = repoSelect.length

  inquirer
    .prompt([
      {
        type: 'confirm',
        name: 'confirm',
        message: `Are you really sure you want to transfer ${total} repositories from ${srcSelect} to ${destSelect}?`
      }
    ])
    .then((answers) => {
      if (answers.confirm) {
        transferRepos()
      } else {
        console.log('Aborting...')
      }
    })
}

// Write repo names to CSV
async function generateCSV() {
  try {
    const columns = {
      repo: 'repo',
      srcOrg: 'srcOrg',
      destOrg: 'destOrg',
      teamId: 'teamId'
    }

    const repoArray = allRepos.map((repo) => {
      return { repo: repo, srcOrg: srcSelect, destOrg: destSelect, teamId: teamSelect }
    })

    const csv = stringify(repoArray, {
      header: true,
      columns: columns
    })
    fs.writeFileSync('repos.csv', csv)

    inquirer
      .prompt([
        {
          type: 'confirm',
          name: 'confirm',
          message: 'CSV file is generated, edit the CSV and press confirm when done'
        }
      ])
      .then((answers) => {
        if (answers.confirm) {
          const total = parse(fs.readFileSync('repos.csv', 'utf8'), { columns: true, skip_empty_lines: true }).length

          inquirer.prompt([{ type: 'confirm', name: 'confirm', message: `Are you really sure you want to transfer ${total} repositories` }]).then((answers) => {
            if (answers.confirm) {
              parseCSV(repoArray)
            } else {
              console.log('Aborting...')
            }
          })
        } else {
          console.log('Aborting...')
        }
      })
  } catch (err) {
    console.error(err.message)
  }
}

// Read CSV file and transfer repositories
async function parseCSV() {
  try {
    const csv = parse(fs.readFileSync('repos.csv', 'utf8'), { columns: true, skip_empty_lines: true })
    for (const row of csv) {
      const data = await octokit.repos.transfer({
        owner: row.srcOrg,
        repo: row.repo,
        new_owner: row.destOrg,
        team_ids: JSON.parse(row.teamId)
      })
      if (data.status === 202) {
        console.log(chalk.green(`Transferred ${row.repo} from ${row.srcOrg} to ${row.destOrg} successfully`))
      } else {
        console.log(chalk.red(`Error transferring ${row.repo} from ${row.srcOrg} to ${row.destOrg} with status ${data.status}`))
      }
    }
  } catch (err) {
    console.error(err.message)
  }
}

// Transfer repositories
async function transferRepos() {
  try {
    for (const repo of repoSelect) {
      const data = await octokit.repos.transfer({
        owner: srcSelect,
        repo: repo,
        new_owner: destSelect,
        team_ids: teamSelect
      })
      if (data.status === 202) {
        console.log(chalk.green(`Transferred ${repo} from ${srcSelect} to ${destSelect} successfully`))
      } else {
        console.log(chalk.red(`Error transferring ${repo} from ${srcSelect} to ${destSelect} with status ${data.status}`))
      }
    }
  } catch (err) {
    console.error(err.message)
  }
}
