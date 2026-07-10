# Nostr Relay Manager

A clean, focused Nostr relay management application built with React and NIP-86 moderation tools.

## 🚀 Quick Start

```bash
npm run dev
```

Open your browser to `http://localhost:5173`

## ✨ Features

### 🔐 **NIP-07 Authentication**
- Secure login with browser extensions (Alby, nos2x, Flamingo)
- No private key handling in the app

### 📋 **Event Management & Moderation**
- **View real-time events** from any Nostr relay
- **Filter by event kind** (text notes, profiles, reactions, etc.)
- **Per-event moderation menu** with NIP-86 actions:
  - Allow/Ban individual events
  - Add moderation reasons
  - Copy event details
- **Visual moderation status** indicators
- **Auto-refresh** every 30 seconds

### 🛠️ **NIP-86 Relay Management**
- Ban/allow events by ID
- View moderation queue
- Authenticated API calls with NIP-98

## 🎯 **Core Focus: Event Moderation**

The app is designed around the **Events & Moderation** tab, which provides:

1. **Real-time event feed** from your relay
2. **Dropdown moderation menu** on each event with options to:
   - Moderate the event (allow/ban)
   - Copy event ID, pubkey, or full JSON
3. **Moderation dialog** with:
   - Action selection (Allow/Ban)
   - Reason field
   - Event details preview
4. **Status indicators** showing which events are banned/pending
5. **Filtering options** by event kind and limit

## 🔧 **Requirements**

### For Basic Event Viewing:
- Any public Nostr relay
- NIP-07 browser extension

### For Full Moderation Features:
- Relay that supports **NIP-86** management API
- Your pubkey must be **authorized** as relay admin
- Relay must have **CORS headers** configured

## 📱 **How to Use**

1. **Install a NIP-07 extension** (Alby recommended)
2. **Start the app** with `npm run dev`
3. **Log in** with your extension
4. **Enter your relay URL** or use quick connect buttons
5. **Go to "Events & Moderation" tab**
6. **Click the ⋮ menu** on any event to moderate it

## 🧪 **Testing Relays**

**For Event Viewing (works with any relay):**
- `wss://relay.damus.io` - Popular, reliable
- `wss://nos.lol` - Community relay
- `wss://relay.nostr.band` - Feature-rich

**For Full Management (requires NIP-86 support):**
- Your own relay with NIP-86 implemented
- Must be configured with your pubkey as admin

## 🛠️ **Technical Stack**

- **React 18** + TypeScript
- **TailwindCSS** + shadcn/ui components
- **TanStack Query** for data fetching
- **Nostrify** for Nostr protocol integration
- **NIP-07** browser extension integration
- **NIP-86** relay management API
- **NIP-98** HTTP authentication

## 🔍 **Troubleshooting**

**"Events not loading":**
- Check relay URL is correct
- Try a different relay from quick connect

**"Moderation not working":**
- Ensure your relay supports NIP-86
- Verify your pubkey is authorized as admin
- Check browser console for CORS errors

**"Login issues":**
- Install a NIP-07 browser extension
- Refresh page after installation

## 🎨 **Clean Architecture**

This is a **focused, minimal implementation** that prioritizes:
- ✅ **Working event moderation** with NIP-86
- ✅ **Clean, intuitive UI** for relay operators
- ✅ **Real-time event viewing** and filtering
- ✅ **Secure authentication** with NIP-07
- ✅ **Responsive design** that works everywhere

The app is built to **just work** for the core use case of moderating events on your Nostr relay.

---

Part of [Divine](https://divine.video) — your playground for human creativity · [Brand guidelines](https://github.com/divinevideo/brand-guidelines)