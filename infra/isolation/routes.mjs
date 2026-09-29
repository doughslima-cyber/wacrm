// The server-route half of isolation.mjs: /api/*, the public API
// (/api/v1) and the RPCs reachable through /api/rest/rpc.
//
// seedRoutes() runs before isolation.mjs takes its snapshot of A's
// rows, attackRoutes() after it; the final "A data unchanged" pass
// then also covers everything attacked here. Several routes answer
// 200 to a foreign id without doing anything (knowledge DELETE,
// quick-replies PATCH/DELETE, automations DELETE, the engine), so the
// snapshot, not the status code, is the real verdict for those.

const ALL_SCOPES = [
  'contacts:read',
  'contacts:write',
  'conversations:read',
  'messages:read',
  'messages:send',
  'broadcasts:send',
  'webhooks:manage',
]

const created = (res) => res.status === 200 || res.status === 201

function must(label, res, pick) {
  if (!created(res)) throw new Error(`seed ${label}: ${res.status} ${res.text.slice(0, 300)}`)
  return pick(res.json)
}

/** A 4xx (or a 200 no-op, which the snapshot judges): anything but a 2xx that returns A's data. */
const refused = (res) => res.status >= 400 && res.status < 500

export async function seedRoutes({ A, B, call, rest, seed, tag8 }) {
  const v1 = (key, method, path, body) =>
    call(null, method, `/api/v1${path}`, { body, headers: { authorization: `Bearer ${key}` } })

  seed.quick_replies_route = must(
    'quick reply',
    await call(A, 'POST', '/api/quick-replies', { body: { title: `Iso QR route ${tag8}`, content_text: 'via rota' } }),
    (j) => j.quick_reply,
  )
  seed.automations = must(
    'automation',
    await call(A, 'POST', '/api/automations', {
      body: {
        name: `Iso automação ${tag8}`,
        trigger_type: 'new_contact_created',
        steps: [{ step_type: 'send_message', step_config: { text: 'segredo da automação de A' } }],
      },
    }),
    (j) => j.automation,
  )
  seed.flows = must('flow', await call(A, 'POST', '/api/flows', { body: { name: `Iso flow ${tag8}` } }), (j) => j.flow)
  const knowledgeId = must(
    'knowledge',
    await call(A, 'POST', '/api/ai/knowledge', { body: { title: `Iso KB ${tag8}`, content: 'conhecimento secreto de A' } }),
    (j) => j.id,
  )
  seed.ai_knowledge_documents = { id: knowledgeId }
  const aKey = must(
    'A api key',
    await call(A, 'POST', '/api/account/api-keys', { body: { name: `iso-a-${tag8}`, scopes: ALL_SCOPES } }),
    (j) => j,
  )
  seed.api_keys = aKey.key
  A.apiKey = aKey.plaintext
  const bKey = must(
    'B api key',
    await call(B, 'POST', '/api/account/api-keys', { body: { name: 'iso-b', scopes: ALL_SCOPES } }),
    (j) => j,
  )
  B.apiKey = bKey.plaintext
  B.apiKeyId = bKey.key.id
  seed.account_invitations = must(
    'invitation',
    await call(A, 'POST', '/api/account/invitations', { body: { role: 'agent' } }),
    (j) => j.invitation,
  )
  seed.webhook_endpoints = must(
    'webhook',
    await v1(A.apiKey, 'POST', '/webhooks', { url: `https://example.com/iso-${tag8}`, events: ['message.received'] }),
    (j) => j.data,
  )
  seed.broadcasts = (
    await rest.insert(A, 'broadcasts', {
      user_id: A.userId,
      account_id: A.accountId,
      name: `Iso broadcast ${tag8}`,
      template_name: 'hello_world',
      template_language: 'en_US',
      status: 'draft',
    })
  ).json?.[0]
  if (!seed.broadcasts) delete seed.broadcasts

  return { v1 }
}

export async function attackRoutes({ A, B, C, call, rest, check, begin, seed, tag8, short, v1 }) {
  const secrets = [seed.contacts.name, seed.messages.content_text, `Iso automação ${tag8}`, `Iso KB ${tag8}`, 'conhecimento secreto de A']
  const shows = (res) => secrets.filter((s) => res.text.includes(s))

  // ----------------------------------------------------------------
  begin('/api/* — B against A ids')
  const attempts = [
    ['PATCH', `/api/quick-replies/${seed.quick_replies_route.id}`, { title: 'pwned' }],
    ['DELETE', `/api/quick-replies/${seed.quick_replies_route.id}`],
    ['PATCH', `/api/quick-replies/${seed.quick_replies.id}`, { title: 'pwned' }],
    ['GET', `/api/automations/${seed.automations.id}`],
    ['PATCH', `/api/automations/${seed.automations.id}`, { name: 'pwned', is_active: true }],
    ['POST', `/api/automations/${seed.automations.id}/duplicate`],
    ['DELETE', `/api/automations/${seed.automations.id}`],
    ['GET', `/api/flows/${seed.flows.id}`],
    ['PUT', `/api/flows/${seed.flows.id}`, { name: 'pwned' }],
    ['POST', `/api/flows/${seed.flows.id}/activate`, { status: 'active' }],
    ['GET', `/api/flows/${seed.flows.id}/runs`],
    ['DELETE', `/api/flows/${seed.flows.id}`],
    ['GET', `/api/ai/knowledge/${seed.ai_knowledge_documents.id}`],
    ['PATCH', `/api/ai/knowledge/${seed.ai_knowledge_documents.id}`, { title: 'pwned' }],
    ['DELETE', `/api/ai/knowledge/${seed.ai_knowledge_documents.id}`],
    ['DELETE', `/api/account/api-keys/${seed.api_keys.id}`],
    ['DELETE', `/api/account/invitations/${seed.account_invitations.id}`],
    ['PATCH', `/api/account/members/${A.userId}`, { role: 'viewer' }],
    ['DELETE', `/api/account/members/${A.userId}`],
    ['POST', '/api/account/transfer-ownership', { newOwnerUserId: A.userId }],
    ['POST', `/api/contacts/${seed.contacts.id}/tags`, { tag_id: seed.tags.id }],
    ['DELETE', `/api/contacts/${seed.contacts.id}/tags`, { tag_id: seed.tags.id }],
    ['POST', `/api/ai/autoreply/${seed.conversations.id}`, { paused: true, assign_to_me: true }],
    ['POST', '/api/whatsapp/react', { message_id: seed.messages.id, emoji: '💀' }],
    ['POST', '/api/whatsapp/send', { conversation_id: seed.conversations.id, content_type: 'text', content_text: 'intruso' }],
    ['POST', '/api/whatsapp/send', { contact_id: seed.contacts.id, content_type: 'text', content_text: 'intruso' }],
    ['PATCH', `/api/whatsapp/templates/${seed.message_templates.id}`, { body_text: 'pwned' }],
    ['DELETE', `/api/whatsapp/templates/${seed.message_templates.id}`],
  ]
  if (seed.broadcasts) attempts.push(['POST', `/api/whatsapp/broadcast/${seed.broadcasts.id}/resume`])
  // Routes known to answer 200 on a foreign id without touching it.
  const NOOP_200 = new Set([
    `DELETE /api/quick-replies/${seed.quick_replies_route.id}`,
    `PATCH /api/quick-replies/${seed.quick_replies_route.id}`,
    `PATCH /api/quick-replies/${seed.quick_replies.id}`,
    `DELETE /api/automations/${seed.automations.id}`,
    `DELETE /api/ai/knowledge/${seed.ai_knowledge_documents.id}`,
  ])
  for (const [method, path, body] of attempts) {
    const res = await call(B, method, path, { body })
    const label = `${method} ${path.replace(/[0-9a-f-]{36}/g, ':id')}`
    const ok = (refused(res) || (NOOP_200.has(`${method} ${path}`) && res.status === 200)) && shows(res).length === 0
    check(label, ok, `${res.status} ${short(res.text)}`)
  }

  // Lists: B's view of each collection has none of A's rows.
  for (const path of ['/api/quick-replies', '/api/automations', '/api/flows', '/api/ai/knowledge', '/api/account/api-keys', '/api/account/invitations', '/api/account/members', '/api/account']) {
    const res = await call(B, 'GET', path)
    const ids = [seed.quick_replies.id, seed.quick_replies_route.id, seed.automations.id, seed.flows.id, seed.ai_knowledge_documents.id, seed.api_keys.id, seed.account_invitations.id, A.userId, A.accountId]
    const found = ids.filter((id) => res.text.includes(id))
    check(`GET ${path} lists nothing of A`, res.status === 200 && found.length === 0, found.length ? `leaks ${found.join(',')}` : `${res.status}`)
  }

  // Automation engine: B's own automation, but A's conversation in the context.
  {
    const bAuto = await call(B, 'POST', '/api/automations', {
      body: {
        name: `Iso B engine ${tag8}`,
        trigger_type: 'new_contact_created',
        is_active: true,
        steps: [{ step_type: 'send_message', step_config: { text: 'intruso via engine' } }],
      },
    })
    const bContact = (await rest.insert(B, 'contacts', { user_id: B.userId, account_id: B.accountId, phone: `+5531${Date.now().toString().slice(-8)}`, name: 'B engine' })).json?.[0]
    const res = await call(B, 'POST', '/api/automations/engine', {
      body: { trigger_type: 'new_contact_created', contact_id: bContact?.id, context: { conversation_id: seed.conversations.id } },
    })
    const msgs = await rest.get(A, 'messages', `conversation_id=eq.${seed.conversations.id}&content_text=eq.intruso via engine`)
    // B has no WhatsApp number here, so the send stops before the insert;
    // with one, engine.ts takes context.conversation_id unchecked.
    check('engine: nothing lands in A conversation (B without WhatsApp)', Array.isArray(msgs.json) && msgs.json.length === 0, `${res.status} ${short(msgs.text)}`)
    if (bAuto.json?.automation) await call(B, 'DELETE', `/api/automations/${bAuto.json.automation.id}`)
    if (bContact) await rest.delete(B, 'contacts', `id=eq.${bContact.id}`)
  }

  // Assigning B's conversation to A's user: the upstream trigger then
  // files a notification for A with text B controls.
  {
    const bContact = (await rest.insert(B, 'contacts', { user_id: B.userId, account_id: B.accountId, phone: `+5541${Date.now().toString().slice(-8)}`, name: `Iso assign ${tag8}` })).json?.[0]
    const bConv = bContact && (await rest.insert(B, 'conversations', { user_id: B.userId, account_id: B.accountId, contact_id: bContact.id, status: 'open' })).json?.[0]
    let assigned = null
    if (bConv) assigned = await rest.patch(B, 'conversations', `id=eq.${bConv.id}`, { assigned_agent_id: A.userId })
    const notes = await rest.get(A, 'notifications', `user_id=eq.${A.userId}&account_id=eq.${B.accountId}`)
    const planted = Array.isArray(notes.json) && notes.json.length > 0
    check('conversations: B cannot assign its conversation to A user', !(assigned?.status === 200 && assigned.json?.length), `${assigned?.status}`)
    check('notifications: nothing from B account reaches A', !planted, planted ? `${notes.json.length} notification(s): ${short(notes.json[0].title)}` : '')
    if (planted) for (const n of notes.json) await rest.delete(A, 'notifications', `id=eq.${n.id}`)
    if (bConv) await rest.delete(B, 'conversations', `id=eq.${bConv.id}`)
    if (bContact) await rest.delete(B, 'contacts', `id=eq.${bContact.id}`)
  }

  // ----------------------------------------------------------------
  begin('/api/v1 — B API key against A ids')
  {
    const tries = [
      ['GET', `/contacts/${seed.contacts.id}`],
      ['PATCH', `/contacts/${seed.contacts.id}`, { name: 'pwned' }],
      ['GET', `/conversations/${seed.conversations.id}`],
      ['GET', `/conversations/${seed.conversations.id}/messages`],
      ['GET', `/webhooks/${seed.webhook_endpoints.id}`],
      ['PATCH', `/webhooks/${seed.webhook_endpoints.id}`, { url: 'https://example.com/pwned' }],
      ['DELETE', `/webhooks/${seed.webhook_endpoints.id}`],
      ['POST', '/messages', { to: seed.contacts.phone, type: 'text', text: 'intruso' }],
    ]
    if (seed.broadcasts) tries.push(['GET', `/broadcasts/${seed.broadcasts.id}`])
    for (const [method, path, body] of tries) {
      const res = await v1(B.apiKey, method, path, body)
      check(`${method} /api/v1${path.replace(/[0-9a-f-]{36}/g, ':id')}`, refused(res) && shows(res).length === 0 && !res.text.includes(seed.webhook_endpoints.url), `${res.status} ${short(res.text)}`)
    }
    for (const path of ['/contacts', '/conversations', `/conversations?contact_id=${seed.contacts.id}`, '/webhooks', '/me']) {
      const res = await v1(B.apiKey, 'GET', path)
      const ids = [seed.contacts.id, seed.conversations.id, seed.webhook_endpoints.id, A.accountId]
      const found = ids.filter((id) => res.text.includes(id))
      check(`GET /api/v1${path.replace(/[0-9a-f-]{36}/g, ':id')} lists nothing of A`, res.status === 200 && found.length === 0, found.length ? `leaks ${found.join(',')}` : `${res.status}`)
    }
    const own = await v1(A.apiKey, 'GET', `/contacts/${seed.contacts.id}`)
    check('control: A key reads A contact', own.status === 200 && own.text.includes(seed.contacts.id), `${own.status}`)
    const none = await call(null, 'GET', '/api/v1/contacts')
    check('no key → 401', none.status === 401, `${none.status}`)
    const bogus = await v1('wacrm_live_bogus', 'GET', '/contacts')
    check('bogus key → 401', bogus.status === 401, `${bogus.status}`)
    const revoke = await call(B, 'DELETE', `/api/account/api-keys/${B.apiKeyId}`)
    const after = await v1(B.apiKey, 'GET', '/me')
    check('revoked key → 401', created(revoke) && after.status === 401, `${revoke.status} → ${after.status}`)
  }

  // ----------------------------------------------------------------
  begin('/api/rest/rpc — SECURITY DEFINER functions')
  {
    const rpcs = [
      ['record_webhook_failure', { endpoint_id: seed.webhook_endpoints.id, max_failures: 1 }],
      ['claim_ai_reply_slot', { conversation_id: seed.conversations.id, max_replies: 1000 }],
      ['merge_duplicate_contacts', {}],
      ['merge_duplicate_conversations', {}],
    ]
    if (seed.broadcasts) {
      rpcs.push(['_bcast_bump', { bid: seed.broadcasts.id, col: 'sent_count', delta: 1 }])
      rpcs.push(['recompute_broadcast_counts', { bid: seed.broadcasts.id }])
    }
    for (const [fn, args] of rpcs) {
      for (const [who, label] of [[null, 'anonymous'], [B, 'B']]) {
        const res = await rest.rpc(who, fn, args)
        check(`${fn} as ${label} refused`, refused(res), `${res.status} ${short(res.text)}`)
      }
    }
    const members = [
      ['set_member_role', { p_user_id: A.userId, p_new_role: 'viewer' }],
      ['remove_account_member', { p_user_id: A.userId }],
      ['transfer_account_ownership', { p_new_owner_user_id: A.userId }],
      ['redeem_invitation', { p_token_hash: 'x'.repeat(64) }],
    ]
    for (const [fn, args] of members) {
      const res = await rest.rpc(B, fn, args)
      check(`${fn} on A as B refused`, refused(res), `${res.status} ${short(res.text)}`)
    }
    const peek = await rest.rpc(null, 'peek_invitation', { p_token_hash: 'x'.repeat(64) })
    check('peek_invitation with a made-up hash reveals nothing', !peek.text.includes(A.accountId), `${peek.status} ${short(peek.text)}`)
    const privileged = await rest.patch(B, 'profiles', `user_id=eq.${B.userId}`, { account_role: 'viewer' })
    check('profiles: B cannot change its own role column', privileged.status >= 400, `${privileged.status} ${short(privileged.text)}`)
  }

  // ----------------------------------------------------------------
  if (C) {
    begin('ex-member — C joins A, writes an automation, is removed')
    const invite = await call(A, 'POST', '/api/account/invitations', { body: { role: 'agent' } })
    const token = invite.json?.token
    const joined = token && (await call(C, 'POST', `/api/invitations/${token}/redeem`))
    check('C redeems A invitation (setup)', joined?.status === 200 && joined.json?.accountId === A.accountId, `${joined?.status} ${short(joined?.text ?? invite.text)}`)
    if (joined?.status === 200) {
      const auto = await call(C, 'POST', '/api/automations', {
        body: { name: `Iso C automação ${tag8}`, trigger_type: 'new_contact_created', steps: [{ step_type: 'send_message', step_config: { text: 'de C em A' } }] },
      })
      const autoId = auto.json?.automation?.id
      const removed = await call(A, 'DELETE', `/api/account/members/${C.userId}`)
      check('A removes C (setup)', created(removed), `${removed.status} ${short(removed.text)}`)
      const cNow = (await rest.get(C, 'profiles', `user_id=eq.${C.userId}&select=account_id`)).json?.[0]
      check('C is back in a personal account', cNow?.account_id && cNow.account_id !== A.accountId, short(cNow))
      if (autoId) {
        for (const [method, path, body] of [
          ['GET', `/api/automations/${autoId}`],
          ['PATCH', `/api/automations/${autoId}`, { name: 'pwned by ex-member' }],
          ['POST', `/api/automations/${autoId}/duplicate`],
        ]) {
          const res = await call(C, method, path, { body })
          check(`ex-member ${method} ${path.replace(/[0-9a-f-]{36}/g, ':id')} refused`, refused(res), `${res.status} ${short(res.text)}`)
        }
        const del = await call(C, 'DELETE', `/api/automations/${autoId}`)
        const still = await rest.get(A, 'automations', `id=eq.${autoId}&select=id,name`)
        check('ex-member DELETE /api/automations/:id leaves it in A', Array.isArray(still.json) && still.json.length === 1, `${del.status} → ${short(still.text)}`)
        // Clean up whatever C left in A (the original and any duplicate).
        await rest.delete(A, 'automations', `name=like.*${tag8}*&user_id=eq.${C.userId}`)
      }
    }
  }
}
