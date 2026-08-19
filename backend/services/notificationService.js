const EventEmitter = require('events');

class NotificationService extends EventEmitter {
  constructor() {
    super();
  }

  emitFor(uid, payload) {
    // payload: { event: 'qr'|'pairing'|'connected'|'error', data: any }
    this.emit(uid, payload);
  }
}

module.exports = new NotificationService();
