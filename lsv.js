const localenv = require('localenv')
const chalk = require('chalk')
const cheerio = require('cheerio')
const request = require('request-promise')
const R = require('ramda')
const Promise = require('bluebird')
const Trello = require('trello') // use fork
const trello = new Trello(process.env.TRELLO_BENCHMARK_API_KEY, process.env.TRELLO_BENCHMARK_USER_TOKEN)

const setReviewUrls = [
  'http://www.channelfireball.com/articles/shadows-over-innistrad-limited-set-review-white/',
  'http://www.channelfireball.com/articles/shadows-over-innistrad-limited-set-review-blue-cards/'
]
const trelloConcurrency = 1
const reviewLimit = Infinity

const dryRun = true // does not add cards to trello

const lsvScale = {
  "5.0": 'The best of the best. (Gideon, Ally of Zendikar. Quarantine Field. Linvala, the Preserver.)',
  "4.5": 'Incredible bomb, but not unbeatable. (Ruinous Path. Drana, Liberator of Malakir. Guardian of Tazeem.)',
  "4.0": 'Good rare or top-tier uncommon. (Tyrant of Valakut. Roil Spout. Nissa’s Judgment.)',
  "3.5": 'Top-tier common or solid uncommon. (Oblivion Strike. Isolation Zone. Eldrazi Skyspawner.)',
  "3.0": 'Good playable that basically always makes the cut. (Benthic Infiltrator. Touch of the Void. Stalking Drone.)',
  "2.5": 'Solid playable that rarely gets cut. (Expedition Raptor. Makindi Aeronaut. Jwar Isle Avenger.)',
  "2.0": 'Good filler, but sometimes gets cut. (Kozilek’s Translator. Murk Strider. Kor Scythemaster.)',
  "1.5": 'Filler. Gets cut about half the time. (Affa Protector. Call of the Scions. Culling Drone.)',
  "1.0": 'Bad filler. Gets cut most of the time. (Salvage Drone. Blisterpod. Dazzling Reflection.)',
  "0.5": 'Very low-end playables and sideboard material. (Geyserfield Stalker. Natural State. Consuming Sinkhole.)',
  "0.0": 'Completely unplayable. (Hedron Alignment. Call of the Gatewatch.) '
}

const log = console.log
const error = R.pipe(chalk.red, console.error)

// lowercase, trim, remove punctuation and extraneous whitespace from a given string
const makeLooselyComparable = R.pipe(
  R.trim,
  R.replace(/ {2,}/g, ' '),
  R.replace(/\W/g, ''),
  R.toLower()
)

const getOneSide = R.replace(/ \/\/.*$/, '')

const eqLoose = R.eqBy(makeLooselyComparable)
const eqLooseFlip = R.eqBy(R.pipe(getOneSide, makeLooselyComparable))

// a loose string contains that ignores case and extra whitespace
const containsLoose = R.useWith(R.any, [eqLoose, R.identity])

function reviewToString(review) {
  const scaleText = review.rating.split(' // ')
    .map(R.flip(R.prop)(lsvScale))
    .join('\n')
  return `LSV: **${review.rating}**\n*${scaleText}*\n\n"${review.text}"`
}

// selects the element and all the next consecutive elmements of the same type
function allNextSame(el) {
  const next = el.next()
  return next.is(el[0].tagName) ?
    el.add(allNextSame(next)) : el
}

// gets all the card reviews from the channelfireball url
function getReviews(url) {

  log(`Fetching ${url}...`)

  return request(url).then(R.pipe(
    cheerio.load,
    $ => $('h3:contains(Limited)')
      .map((i, el) => {
        const heading = $(el).prev().prev()
        const next = $(el).next()
        // skip flavor
        const nextStart = next.text().startsWith('Flavor') ? next.next() : next
        return {
          name: heading.text().trim(),
          rating: $(el).text().slice(9).trim(),
          text: allNextSame(nextStart)
            .map((i, el) => $(el).text().trim())
            .toArray()
            .join('\n\n')
        }
      })
      .toArray()
  ))
}

// const lists = trello.getListsOnBoard(process.env.BOARD_ID)
const allCards = Promise.resolve(trello.getCardsOnBoard(process.env.BOARD_ID))
const reviews = Promise.all(setReviewUrls.map(getReviews))
  .then(R.pipe(
    R.flatten,
    R.take(reviewLimit)
  ))

const unmatchedCards = Promise.all([allCards, reviews])
  .then(R.pipe(
    R.map(R.pluck('name')),
    ([allCardNames, reviewNames]) => R.differenceWith(eqLooseFlip, reviewNames, allCardNames),
    unmatched => {
      if(unmatched.length) {
        error('Some review cards could not be matched to Trello cards:')
        error(unmatched.map(R.concat('  ')).join('\n'))
        process.exit(1)
      }
      else {
        log('All review cards matched to Trello cards!')
      }
    }
  ))

// log some stuff
reviews.tap(x => log(`Scraped ${x.length} reviews.`))
allCards.tap(x => log(`${x.length} cards on board.`))

// add reviews to Trello cards
Promise.join(allCards, reviews, (allCards, reviews) => {
  return Promise.all(reviews.map(review => {
    const card = allCards.find(R.pipe(R.prop('name'), eqLooseFlip(review.name)))
    log(`Adding review to ${card.name}.`)
    if(!dryRun) {
      return trello.addCommentToCard(card.id, reviewToString(review))
    }
  }), { concurrency: trelloConcurrency})
})
