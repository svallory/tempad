CREATE INDEX IF NOT EXISTS events_quest_declared_session
  ON events(json_extract(payload, '$.session_id'))
  WHERE kind = 'quest.declared';
