select id, status, kickoff_at from matches order by kickoff_at;
update matches set status = 'live' where id = 'a2222222-2222-2222-2222-222222222222';