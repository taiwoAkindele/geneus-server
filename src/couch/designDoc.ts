import { DocType } from '#shared';

/**
 * The database-level guard (SCHEMA.md §6). CouchDB runs this in its own JS
 * engine and cannot import the contract, so the parts that vary — the list of
 * document types — are injected from the contract at deploy time rather than
 * hand-copied. It stays a thin structural check: rich validation is Zod's job
 * on the two write paths.
 */
export const buildDesignDoc = (facilityId: string) => ({
  _id: '_design/geneus',
  validate_doc_update: `function (newDoc, oldDoc) {
  // Clinical history is never destroyed: the app retires records by flag
  // (active: false, superseded versions), so a delete can only be a mistake or
  // an attacker holding a device credential.
  if (newDoc._deleted) {
    throw { forbidden: 'documents cannot be deleted; retire them instead' };
  }

  var TYPES = ${JSON.stringify(DocType.options)};
  var FACILITY_ID = ${JSON.stringify(facilityId)};

  if (!newDoc.type || TYPES.indexOf(newDoc.type) === -1) {
    throw { forbidden: 'unknown document type: ' + newDoc.type };
  }
  if (newDoc.facilityId !== FACILITY_ID) {
    throw { forbidden: 'document belongs to another facility: ' + newDoc.facilityId };
  }
  var required = ['createdBy', 'createdOn', 'deviceId', 'schemaVersion'];
  for (var i = 0; i < required.length; i++) {
    if (newDoc[required[i]] === undefined || newDoc[required[i]] === null) {
      throw { forbidden: 'missing required field: ' + required[i] };
    }
  }
  if (oldDoc) {
    var immutable = ['type', 'patientId', 'referralId', 'registerId', 'staffId'];
    for (var j = 0; j < immutable.length; j++) {
      var key = immutable[j];
      if (oldDoc[key] !== undefined && newDoc[key] !== oldDoc[key]) {
        throw { forbidden: 'cannot change ' + key };
      }
    }
  }
}`,
});
