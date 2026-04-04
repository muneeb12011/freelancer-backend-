# Freelancer Assistant — Backend API

Node.js + Express + MongoDB Atlas REST API

## Setup

```bash
# 1. Install dependencies
npm install

# 2. Create your .env file
cp .env.example .env
# Then fill in your MONGO_URI and JWT_SECRET

# 3. Start dev server
npm run dev

# 4. Start production server
npm start
```

## Folder Structure

```
backend/
├── config/
│   └── db.js              # MongoDB Atlas connection
├── middleware/
│   ├── auth.js            # JWT protect middleware
│   └── errorHandler.js    # Global error handler
├── models/
│   ├── User.js
│   ├── Client.js
│   ├── Connection.js
│   ├── Invoice.js
│   ├── Task.js
│   ├── Note.js
│   ├── Earning.js
│   ├── Contract.js
│   └── Proposal.js
├── routes/
│   ├── auth.js            # /api/auth
│   ├── clients.js         # /api/clients
│   ├── connections.js     # /api/connections
│   ├── invoices.js        # /api/invoices
│   ├── tasks.js           # /api/tasks
│   ├── notes.js           # /api/notes
│   ├── earnings.js        # /api/earnings
│   ├── contracts.js       # /api/contracts
│   ├── proposals.js       # /api/proposals
│   └── dashboard.js       # /api/dashboard
├── .env.example
├── .gitignore
├── package.json
└── server.js
```

## API Endpoints

### Auth
| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | /api/auth/register | Register new user |
| POST | /api/auth/login | Login + get token |
| GET  | /api/auth/me | Get current user |
| PATCH| /api/auth/me | Update profile |
| POST | /api/auth/change-password | Change password |

### Clients
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET    | /api/clients | List all clients |
| POST   | /api/clients | Create client |
| GET    | /api/clients/:id | Get single client |
| PATCH  | /api/clients/:id | Update client |
| DELETE | /api/clients/:id | Delete client |

### Connections
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET    | /api/connections | List connections |
| POST   | /api/connections | Add connection |
| PATCH  | /api/connections/:id | Update connection |
| DELETE | /api/connections/:id | Remove connection |
| GET    | /api/connections/chat/:id | Get chat messages |
| POST   | /api/connections/chat/:id | Send message |
| POST   | /api/connections/collab | Send collab request |
| POST   | /api/connections/invite | Generate invite link |

### Invoices
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET    | /api/invoices | List invoices |
| POST   | /api/invoices | Create invoice |
| PUT    | /api/invoices/:id | Update / mark paid |
| DELETE | /api/invoices/:id | Delete invoice |

### Tasks
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET    | /api/tasks | List tasks |
| POST   | /api/tasks | Create task |
| PATCH  | /api/tasks/:id | Update task |
| DELETE | /api/tasks/:id | Delete task |
| POST   | /api/tasks/reorder | Bulk reorder (Kanban) |

### Dashboard
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET    | /api/dashboard | Full stats object |
| GET    | /api/dashboard/stats | Lightweight counts |

## Environment Variables

```env
PORT=5000
NODE_ENV=development
MONGO_URI=mongodb+srv://...
JWT_SECRET=your_secret_here
JWT_EXPIRES_IN=7d
CLIENT_URL=http://localhost:3000
```

## MongoDB Atlas Free Tier (M0)
- 512MB storage — enough for thousands of clients, tasks, invoices
- Connect from anywhere — whitelist `0.0.0.0/0` in Network Access
- Free forever — no credit card needed
