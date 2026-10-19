// services/help.js — the help library. Written for situations people are actually in on a
// marketplace ("the client hasn't paid", "the job looks fake"), not for menu items.
// Each article: slug, topic, title, body (paragraphs), optional steps, and links to the screen
// where you act on it. `keywords` feed the search on the Support page.

const TOPICS = [
  { id: 'paid', name: 'Getting paid' },
  { id: 'hiring', name: 'Hiring' },
  { id: 'contracts', name: 'Contracts & scope' },
  { id: 'disputes', name: 'Disagreements' },
  { id: 'safety', name: 'Scams & safety' },
  { id: 'account', name: 'Account & verification' },
  { id: 'plans', name: 'Plans' },
];

const ARTICLES = [
  // Getting paid
  {
    slug: 'how-payment-works', topic: 'paid', title: 'How money moves on Aurelance',
    keywords: 'payment pay paid escrow fee commission cut transfer direct',
    body: [
      'Clients pay you directly — bank transfer, Payoneer, Wise or card — to the payout method you verified. Aurelance never holds the money and takes no cut of it.',
      'What Aurelance does is keep the record: each milestone moves from delivered to approved to paid to received, with a timestamp and who did it. That record is what your report card, your statement and any dispute are built from.',
    ],
    steps: ['You deliver a milestone.', 'The client approves it.', 'The client sends the money and marks it paid, with the transfer reference.', 'You confirm it arrived — or say it didn’t.'],
    links: [{ label: 'Your contracts', to: '/contracts' }, { label: 'Payment statement', to: '/contracts/statement' }],
  },
  {
    slug: 'client-not-paying', topic: 'paid', title: 'The client approved my work but hasn’t paid',
    keywords: 'unpaid late payment not paid owe overdue client ignoring',
    body: [
      'Once a milestone is approved the client is reminded automatically, and after 7 days unpaid it shows as late on their client report card — the one every freelancer sees before applying to them.',
      'If it’s been more than a week, send one short message in the contract thread with the amount and your payout method. Most late payments are forgotten, not refused.',
      'If there’s still nothing, open a dispute from the milestone. The client has 7 days to answer, then a person here decides. A dispute lost for not paying is recorded on their report card.',
    ],
    links: [{ label: 'Your contracts', to: '/contracts' }],
    situation: 'unpaid',
  },
  {
    slug: 'marked-paid-not-received', topic: 'paid', title: 'The client marked it paid, but the money hasn’t arrived',
    keywords: 'not received missing transfer marked paid reference bank delay',
    body: [
      'Bank transfers inside Pakistan usually land the same day; international ones through Payoneer or Wise can take 1–3 business days. Check the transfer reference the client entered against your statement first.',
      'If it still isn’t there, choose “I haven’t received this” on the milestone. The client is told straight away and asked to check their transfer. Don’t confirm a payment you can’t see — once you confirm, it counts as received on both records.',
    ],
    links: [{ label: 'Your contracts', to: '/contracts' }],
    situation: 'not_received',
  },
  {
    slug: 'payout-methods', topic: 'paid', title: 'Adding and verifying a payout method',
    keywords: 'payout bank iban payoneer wise visa card verify verified account details',
    body: [
      'Add a bank account (IBAN), Payoneer, Wise or a Visa/Mastercard under Settings → Payouts. Account numbers are encrypted and only you can reveal them, with your password.',
      'Bank accounts get an IBAN checksum and a statement or screenshot showing your name. Payoneer and Wise get a code sent to that account’s email plus a screenshot. Cards need a photo with the middle digits covered. A person checks the name matches your ID, then the proof is deleted.',
      'Clients only ever see the method type and a “verified” mark, never the numbers, until you’ve both signed a contract.',
    ],
    links: [{ label: 'Payout methods', to: '/settings?tab=payouts' }],
    situation: 'payout',
  },
  {
    slug: 'statement-tax', topic: 'paid', title: 'Getting a statement for tax or a visa application',
    keywords: 'statement tax fbr income proof csv export year report',
    body: [
      'Contracts → Payment statement lists every payment you received or made, by date, with the contract and reference. Pick a range — the Pakistani tax year (July to June) is one click — then download a CSV or print it to PDF.',
      'Only payments that were confirmed as received are counted, so the totals match what actually reached you.',
    ],
    links: [{ label: 'Payment statement', to: '/contracts/statement' }],
  },

  // Hiring
  {
    slug: 'post-a-job', topic: 'hiring', title: 'Posting a job that gets good applicants',
    keywords: 'post job hire freelancer budget description applicants',
    body: [
      'Say what “done” looks like, the budget range and the deadline. A clear budget saves you from reading applications that were never going to fit.',
      'Posts are checked for scam patterns before they go live. Phone numbers or a push to WhatsApp put a warning on the post; asking applicants for fees or deposits holds it until a person has reviewed it.',
      'You need a confirmed email to post. Free accounts can have 3 open posts at once.',
    ],
    links: [{ label: 'Post a job', to: '/jobs/new' }],
  },
  {
    slug: 'no-ghosting', topic: 'hiring', title: 'The no-ghosting rule',
    keywords: 'ghost ghosting reply answer applicants closed 14 days',
    body: [
      'Every applicant gets an answer. If you don’t shortlist, decline or message an applicant for 14 days, the job closes, they’re told, and it shows on your client report card as “closed without an answer”.',
      'You’re reminded at day 10. Declining takes one click and you can pick a reason, so it costs less than leaving people waiting.',
    ],
    links: [{ label: 'Your job posts', to: '/jobs?tab=posted' }],
    situation: 'ghosting',
  },
  {
    slug: 'paid-trials', topic: 'hiring', title: 'Paid trials: try someone on a small real task',
    keywords: 'trial test task paid trial small job',
    body: [
      'Instead of hiring straight away, offer up to 10 shortlisted applicants a small paid task. Each one gets a contract with one milestone; you pay for what they deliver.',
      'It’s the fairest way to compare people, and for freelancers it beats unpaid “test tasks” — which are not allowed here.',
    ],
    links: [{ label: 'Post a paid trial', to: '/jobs/new?kind=trial' }],
  },
  {
    slug: 'squads', topic: 'hiring', title: 'Hiring a squad instead of one person',
    keywords: 'squad team agency group multiple freelancers',
    body: [
      'A squad is a small team that has agreed to work together — say a designer, a developer and a copywriter. You hire the squad through its lead, and every member’s record shows the contract.',
    ],
    links: [{ label: 'Find squads', to: '/talent?tab=squads' }],
  },

  // Contracts & scope
  {
    slug: 'scope-lock', topic: 'contracts', title: 'Scope lock and change requests',
    keywords: 'scope creep change request extra work more revisions lock',
    body: [
      'Once both of you sign, the scope and milestones are locked. Nobody can quietly edit them.',
      'Anything new goes through a change request: what’s being added, the extra amount and days. The other side accepts or declines it, and accepted changes become new milestones. This is the cleanest way to say “happy to, here’s what it costs”.',
    ],
    links: [{ label: 'Your contracts', to: '/contracts' }],
  },
  {
    slug: 'late-delivery', topic: 'contracts', title: 'The freelancer is late or has gone quiet',
    keywords: 'late delivery missed deadline not responding quiet disappeared',
    body: [
      'Each milestone has a due date, and it shows on the freelancer’s Home three days before. A missed date counts against their “delivered on time” figure.',
      'Ask in the contract thread first — say what you need and by when. If there’s no answer within a few days, you can end the contract (approved or paid milestones stay on record) or open a dispute if money is involved.',
    ],
    links: [{ label: 'Your contracts', to: '/contracts' }],
    situation: 'late',
  },
  {
    slug: 'ending-a-contract', topic: 'contracts', title: 'Ending a contract early',
    keywords: 'end cancel contract stop early terminate',
    body: [
      'Either side can end an active contract. Milestones already approved still need paying, and they stay on both records. Open milestones are closed.',
      'Ending isn’t a dispute and doesn’t count against anyone by itself. Both sides can still leave a review.',
    ],
    links: [{ label: 'Your contracts', to: '/contracts' }],
  },
  {
    slug: 'reviews', topic: 'contracts', title: 'How reviews work',
    keywords: 'review rating stars feedback hidden reveal blind',
    body: [
      'Reviews are double-blind. After a contract finishes, both sides have 14 days to write one, and neither sees the other’s until both are in or the window closes. So nobody can retaliate.',
      'Only finished contracts can be reviewed, so every review on a profile comes from paid work here.',
    ],
  },

  // Disagreements
  {
    slug: 'disputes', topic: 'disputes', title: 'Opening a dispute',
    keywords: 'dispute disagreement conflict refund evidence decide admin',
    body: [
      'Open a dispute from the contract when you can’t settle it in messages: money not received, work not delivered, work not as agreed, or a scope disagreement.',
      'Write what happened and attach evidence from the contract thread. The other side has 7 days to respond. Then a person here reads both sides and the contract record and decides: for you, for them, shared, or nobody at fault.',
      'The outcome is recorded on both report cards. You can withdraw a dispute any time before it’s decided.',
    ],
    links: [{ label: 'Your contracts', to: '/contracts' }],
    situation: 'dispute',
  },

  // Scams & safety
  {
    slug: 'spot-a-scam', topic: 'safety', title: 'Spotting a scam job or client',
    keywords: 'scam fake fraud suspicious whatsapp telegram fee deposit cheque crypto',
    body: [
      'Almost every freelance scam does one of these: asks you to pay a fee or deposit first, moves the chat to WhatsApp or Telegram, asks for your CNIC or bank login, pays with a cheque or crypto “overpayment”, or promises a lot of money for very little work.',
      'Aurelance checks posts and messages for these patterns and shows a warning, but no filter catches everything. A real client never needs you to pay them.',
      'If something feels off, report it from the job or message menu. Every report is read by a person, and you can also write to support below with the details.',
    ],
    links: [{ label: 'Find work', to: '/jobs' }],
    situation: 'scam',
  },
  {
    slug: 'stay-on-platform', topic: 'safety', title: 'Why agreements should stay on Aurelance',
    keywords: 'off platform whatsapp outside contact phone',
    body: [
      'It’s fine to talk on a call. But keep the scope, prices and deliveries in the contract and thread here — if it isn’t recorded, nobody can help you prove it later, and it doesn’t build your record.',
    ],
  },

  // Account
  {
    slug: 'identity-check', topic: 'account', title: 'The ID check',
    keywords: 'id identity cnic passport verify verification selfie rejected',
    body: [
      'Settings → Verification. Upload your CNIC, passport, national ID or driving licence and a selfie. A person checks it within one business day and the photos are deleted as soon as it’s decided.',
      'Common reasons it’s sent back: the photo is blurry or cropped, the name doesn’t match your account name, or the document has expired. Fix the one that applies and send it again — there’s no limit.',
    ],
    links: [{ label: 'Verification', to: '/settings?tab=verification' }],
    situation: 'identity',
  },
  {
    slug: 'public-link', topic: 'account', title: 'Your public profile link',
    keywords: 'profile link handle url share public username',
    body: [
      'Your profile has a public address like aurelance.app/u/your-name that opens without an account. Change the name part under Edit profile. It shows your record, portfolio and reviews — never your email or phone unless you choose to.',
    ],
    links: [{ label: 'Your profile', to: '/profile' }],
  },
  {
    slug: 'sign-in-trouble', topic: 'account', title: 'Can’t sign in',
    keywords: 'password forgot reset login sign in locked google github',
    body: [
      'Use “Forgot password?” on the sign-in page — the link works for one hour. If you signed up with Google or GitHub, use that button instead; there may be no password on the account.',
      'Changing your password signs out every other device.',
    ],
    links: [{ label: 'Security settings', to: '/settings?tab=security' }],
  },

  // Plans
  {
    slug: 'free-vs-premium', topic: 'plans', title: 'What’s free and what Premium adds',
    keywords: 'free premium price plan upgrade limits applications cancel',
    body: [
      'Applying is free — no bidding credits. Free accounts get 15 applications a month and 3 open job posts; Premium removes the application limit, allows 25 open posts and adds more AI drafting.',
      'Premium is prepaid, so nothing renews unless you pay again.',
    ],
    links: [{ label: 'Plans', to: '/billing' }],
  },
];

const BY_SLUG = Object.fromEntries(ARTICLES.map((a) => [a.slug, a]));
const forSituation = (s) => ARTICLES.find((a) => a.situation === s)?.slug;

module.exports = { TOPICS, ARTICLES, BY_SLUG, forSituation };
