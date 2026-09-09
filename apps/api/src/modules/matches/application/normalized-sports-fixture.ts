export type NormalizedFixtureStatus = 'scheduled' | 'live' | 'finished' | 'postponed' | 'cancelled';

export type NormalizedSportsFixture = {
  provider: 'api-football';
  externalFixtureId: number;
  externalLeagueId: number;
  externalLeagueName: string;
  season: number;
  homeTeam: {
    externalTeamId: number;
    name: string;
  };
  awayTeam: {
    externalTeamId: number;
    name: string;
  };
  kickoffAt: string;
  status: NormalizedFixtureStatus;
};
