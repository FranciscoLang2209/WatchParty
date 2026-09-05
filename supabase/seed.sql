-- Datos de ejemplo para desarrollo local. Ficticios: no representan datos
-- reales de ningún proveedor (en particular, no de API-Football).

insert into teams (id, provider, external_id, name) values
                                                        ('11111111-1111-1111-1111-111111111111', 'local-fixtures', 'team-1', 'Club Atlético Norte'),
                                                        ('22222222-2222-2222-2222-222222222222', 'local-fixtures', 'team-2', 'Deportivo Sur'),
                                                        ('33333333-3333-3333-3333-333333333333', 'local-fixtures', 'team-3', 'Unión Central'),
                                                        ('44444444-4444-4444-4444-444444444444', 'local-fixtures', 'team-4', 'Atlético Este');

insert into matches (
    id, provider, external_id, home_team_id, away_team_id,
    competition_external_id, season, kickoff_at, status
) values
      (
          'a1111111-1111-1111-1111-111111111111', 'local-fixtures', 'match-1',
          '11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222',
          'liga-local', '2026', now() + interval '2 days', 'scheduled'
      ),
      (
          'a2222222-2222-2222-2222-222222222222', 'local-fixtures', 'match-2',
          '33333333-3333-3333-3333-333333333333', '44444444-4444-4444-4444-444444444444',
          'liga-local', '2026', now() - interval '2 hours', 'live'
      ),
      (
          'a3333333-3333-3333-3333-333333333333', 'local-fixtures', 'match-3',
          '11111111-1111-1111-1111-111111111111', '33333333-3333-3333-3333-333333333333',
          'liga-local', '2026', now() - interval '3 days', 'finished'
      );

insert into provider_sync_state (
    provider, competition_external_id, season, last_attempt_at, last_success_at
) values (
             'local-fixtures', 'liga-local', '2026', now() - interval '1 hour', now() - interval '1 hour'
         );