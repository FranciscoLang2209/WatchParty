import { describe, expect, it, vi } from 'vitest';

vi.mock('../../lib/supabase', () => ({ supabase: {} }));

const { subscribeToRoomComments } = await import('./realtime');

type Cliente = NonNullable<NonNullable<Parameters<typeof subscribeToRoomComments>[2]>['client']>;

const fila = {
  id: 'comentario-1',
  room_id: 'room-1',
  author_id: 'user-1',
  body: '¡Qué golazo!',
  client_request_id: 'req-1',
  created_at: '2026-09-24T21:00:00.000Z',
};

function crearCliente() {
  let entregar: (payload: { new: unknown }) => void = () => {};
  let avisar: (estado: string) => void = () => {};

  const channel = { on: vi.fn(), subscribe: vi.fn() };
  channel.on.mockImplementation(
    (_tipo: string, _filtro: unknown, callback: (payload: { new: unknown }) => void) => {
      entregar = callback;
      return channel;
    },
  );
  channel.subscribe.mockImplementation((callback?: (estado: string) => void) => {
    if (callback) avisar = callback;
    return channel;
  });

  const client = { channel: vi.fn(() => channel), removeChannel: vi.fn() };

  return {
    client: client as unknown as Cliente,
    mocks: client,
    channel,
    emitir: (row: unknown) => entregar({ new: row }),
    /** Simula el aviso de estado del canal de Supabase (`SUBSCRIBED`, `CLOSED`, …). */
    avisarEstado: (estado: string) => avisar(estado),
  };
}

describe('subscribeToRoomComments', () => {
  it('se suscribe a los INSERT de room_comments filtrados por la sala', () => {
    const { client, mocks, channel } = crearCliente();

    subscribeToRoomComments('room-1', vi.fn(), { client });

    expect(mocks.channel).toHaveBeenCalledWith('room-comments:room-1');
    expect(channel.on).toHaveBeenCalledWith(
      'postgres_changes',
      {
        event: 'INSERT',
        schema: 'public',
        table: 'room_comments',
        filter: 'room_id=eq.room-1',
        select: ['id', 'room_id', 'body', 'created_at'],
      },
      expect.any(Function),
    );
    expect(channel.subscribe).toHaveBeenCalledTimes(1);
  });

  it('entrega el comentario con el contrato público, sin campos internos', () => {
    const { client, emitir } = crearCliente();
    const onComment = vi.fn();

    subscribeToRoomComments('room-1', onComment, { client });
    emitir(fila);

    expect(onComment).toHaveBeenCalledTimes(1);
    expect(onComment).toHaveBeenCalledWith({
      id: 'comentario-1',
      roomId: 'room-1',
      body: '¡Qué golazo!',
      createdAt: '2026-09-24T21:00:00.000Z',
    });
  });

  it('entrega una sola vez un comentario que llega repetido', () => {
    const { client, emitir } = crearCliente();
    const onComment = vi.fn();

    subscribeToRoomComments('room-1', onComment, { client });
    emitir(fila);
    emitir(fila);

    expect(onComment).toHaveBeenCalledTimes(1);
  });

  it('ignora payloads inválidos o de otra sala', () => {
    const { client, emitir } = crearCliente();
    const onComment = vi.fn();

    subscribeToRoomComments('room-1', onComment, { client });
    emitir(null);
    emitir({});
    emitir({ ...fila, id: 42 });
    emitir({ ...fila, body: undefined });
    emitir({ ...fila, room_id: 'room-2' });

    expect(onComment).not.toHaveBeenCalled();
  });

  it('al cancelar cierra el canal y deja de entregar', () => {
    const { client, mocks, channel, emitir } = crearCliente();
    const onComment = vi.fn();

    const cancelar = subscribeToRoomComments('room-1', onComment, { client });
    cancelar();
    emitir(fila);

    expect(mocks.removeChannel).toHaveBeenCalledWith(channel);
    expect(onComment).not.toHaveBeenCalled();
  });

  describe('estado de la suscripción', () => {
    it('no avisa nada antes de que el canal confirme: sigue desconectada', () => {
      const { client } = crearCliente();
      const onStatusChange = vi.fn();

      subscribeToRoomComments('room-1', vi.fn(), { client, onStatusChange });

      expect(onStatusChange).not.toHaveBeenCalled();
    });

    it('avisa connected cuando el canal confirma la suscripción', () => {
      const { client, avisarEstado } = crearCliente();
      const onStatusChange = vi.fn();

      subscribeToRoomComments('room-1', vi.fn(), { client, onStatusChange });
      avisarEstado('SUBSCRIBED');

      expect(onStatusChange).toHaveBeenCalledTimes(1);
      expect(onStatusChange).toHaveBeenLastCalledWith('connected');
    });

    it.each(['CHANNEL_ERROR', 'TIMED_OUT', 'CLOSED'])(
      'vuelve a disconnected ante %s',
      (estadoDelCanal) => {
        const { client, avisarEstado } = crearCliente();
        const onStatusChange = vi.fn();

        subscribeToRoomComments('room-1', vi.fn(), { client, onStatusChange });
        avisarEstado('SUBSCRIBED');
        avisarEstado(estadoDelCanal);

        expect(onStatusChange).toHaveBeenCalledTimes(2);
        expect(onStatusChange).toHaveBeenLastCalledWith('disconnected');
      },
    );

    it('no repite el aviso si el estado no cambió', () => {
      const { client, avisarEstado } = crearCliente();
      const onStatusChange = vi.fn();

      subscribeToRoomComments('room-1', vi.fn(), { client, onStatusChange });
      avisarEstado('CHANNEL_ERROR');
      avisarEstado('SUBSCRIBED');
      avisarEstado('SUBSCRIBED');

      expect(onStatusChange.mock.calls).toEqual([['connected']]);
    });

    it('vuelve a connected si el canal se recupera', () => {
      const { client, avisarEstado } = crearCliente();
      const onStatusChange = vi.fn();

      subscribeToRoomComments('room-1', vi.fn(), { client, onStatusChange });
      avisarEstado('SUBSCRIBED');
      avisarEstado('CHANNEL_ERROR');
      avisarEstado('SUBSCRIBED');

      expect(onStatusChange.mock.calls).toEqual([['connected'], ['disconnected'], ['connected']]);
    });

    it('al cancelar queda disconnected y no avisa más', () => {
      const { client, avisarEstado } = crearCliente();
      const onStatusChange = vi.fn();

      const cancelar = subscribeToRoomComments('room-1', vi.fn(), { client, onStatusChange });
      avisarEstado('SUBSCRIBED');
      cancelar();
      avisarEstado('CLOSED');
      avisarEstado('SUBSCRIBED');

      expect(onStatusChange.mock.calls).toEqual([['connected'], ['disconnected']]);
    });

    it('sigue entregando el comentario una sola vez mientras cambia el estado', () => {
      const { client, emitir, avisarEstado } = crearCliente();
      const onComment = vi.fn();

      subscribeToRoomComments('room-1', onComment, { client, onStatusChange: vi.fn() });
      avisarEstado('SUBSCRIBED');
      emitir(fila);
      avisarEstado('CHANNEL_ERROR');
      avisarEstado('SUBSCRIBED');
      emitir(fila);

      expect(onComment).toHaveBeenCalledTimes(1);
    });
  });
});
