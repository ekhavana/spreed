/**
 *
 * @copyright Copyright (c) 2019, Daniel Calviño Sánchez (danxuliu@gmail.com)
 *
 * @license GNU AGPL version 3 or any later version
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as
 * published by the Free Software Foundation, either version 3 of the
 * License, or (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program.  If not, see <http://www.gnu.org/licenses/>.
 *
 */

import attachMediaStream from 'attachmediastream'

export const ConnectionState = {
	NEW: 'new',
	CHECKING: 'checking',
	CONNECTED: 'connected',
	COMPLETED: 'completed',
	DISCONNECTED: 'disconnected',
	DISCONNECTED_LONG: 'disconnected-long', // Talk specific
	FAILED: 'failed',
	FAILED_NO_RESTART: 'failed-no-restart', // Talk specific
	CLOSED: 'closed',
}

export default function CallParticipantModel(options) {

	this.attributes = {
		peerId: null,
		// "undefined" is used for values not known yet; "null" or "false"
		// are used for known but negative/empty values.
		userId: undefined,
		name: undefined,
		connectionState: ConnectionState.NEW,
		stream: null,
		// The audio element is part of the model to ensure that it can be
		// played if needed even if there is no view for it.
		audioElement: null,
		audioAvailable: undefined,
		speaking: undefined,
		videoAvailable: undefined,
		screen: null,
	}

	this.set('peerId', options.peerId)

	this._webRtc = options.webRtc

	this._handlePeerStreamAddedBound = this._handlePeerStreamAdded.bind(this)
	this._handlePeerStreamRemovedBound = this._handlePeerStreamRemoved.bind(this)
	this._handleNickBound = this._handleNick.bind(this)
	this._handleMuteBound = this._handleMute.bind(this)
	this._handleUnmuteBound = this._handleUnmute.bind(this)
	this._handleExtendedIceConnectionStateChangeBound = this._handleExtendedIceConnectionStateChange.bind(this)
	this._handleChannelMessageBound = this._handleChannelMessage.bind(this)

	this._webRtc.on('peerStreamAdded', this._handlePeerStreamAddedBound)
	this._webRtc.on('peerStreamRemoved', this._handlePeerStreamRemovedBound)
	this._webRtc.on('nick', this._handleNickBound)
	this._webRtc.on('mute', this._handleMuteBound)
	this._webRtc.on('unmute', this._handleUnmuteBound)
	this._webRtc.on('channelMessage', this._handleChannelMessageBound)

}

CallParticipantModel.prototype = {

	get: function(key) {
		return this.attributes[key]
	},

	set: function(key, value) {
		this.attributes[key] = value
	},

	_handlePeerStreamAdded: function(peer) {
		if (this._peer === peer) {
			this.set('stream', this._peer.stream || null)
			this.set('audioElement', attachMediaStream(this.get('stream'), null, { audio: true }))
			this.get('audioElement').muted = !this.get('audioAvailable')

			// "peer.nick" is set only for users and when the MCU is not used.
			if (this._peer.nick !== undefined) {
				this.set('name', this._peer.nick)
			}
		} else if (this._screenPeer === peer) {
			this.set('screen', this._screenPeer.stream || null)
		}
	},

	_handlePeerStreamRemoved: function(peer) {
		if (this._peer === peer) {
			this.get('audioElement').srcObject = null
			this.set('audioElement', null)
			this.set('stream', null)
			this.set('audioAvailable', undefined)
			this.set('speaking', undefined)
			this.set('videoAvailable', undefined)
		} else if (this._screenPeer === peer) {
			this.set('screen', null)
		}
	},

	_handleNick: function(data) {
		if (!this._peer || this._peer.id !== data.id) {
			return
		}

		this.set('userId', data.userid || null)
		this.set('name', data.name || null)
	},

	_handleMute: function(data) {
		if (!this._peer || this._peer.id !== data.id) {
			return
		}

		if (data.name === 'video') {
			this.set('videoAvailable', false)
		} else {
			if (this.get('audioElement')) {
				this.get('audioElement').muted = true
			}
			this.set('audioAvailable', false)
			this.set('speaking', false)
		}
	},

	forceMute: function() {
		if (!this._peer) {
			return
		}

		this._webRtc.sendToAll('control', {
			action: 'forceMute',
			peerId: this._peer.id,
		})

		// Mute locally too, as even when sending to all the sender will not
		// receive the message.
		this._handleMute({ id: this._peer.id })
	},

	_handleUnmute: function(data) {
		if (!this._peer || this._peer.id !== data.id) {
			return
		}

		if (data.name === 'video') {
			this.set('videoAvailable', true)
		} else {
			if (this.get('audioElement')) {
				this.get('audioElement').muted = false
			}
			this.set('audioAvailable', true)
		}
	},

	_handleChannelMessage: function(peer, label, data) {
		if (!this._peer || this._peer.id !== peer.id) {
			return
		}

		if (label !== 'status') {
			return
		}

		if (data.type === 'speaking') {
			this.set('speaking', true)
		} else if (data.type === 'stoppedSpeaking') {
			this.set('speaking', false)
		}
	},

	setPeer: function(peer) {
		if (peer && this.get('peerId') !== peer.id) {
			console.warn('Mismatch between stored peer ID and ID of given peer: ', this.get('peerId'), peer.id)
		}

		if (this._peer) {
			this._peer.off('extendedIceConnectionStateChange', this._handleExtendedIceConnectionStateChangeBound)
		}

		this._peer = peer

		// Special case when the participant has no streams.
		if (!this._peer) {
			this.set('connectionState', ConnectionState.COMPLETED)
			this.set('audioAvailable', false)
			this.set('speaking', false)
			this.set('videoAvailable', false)

			return
		}

		// Reset state that depends on the Peer object.
		this._handleExtendedIceConnectionStateChange(this._peer.pc.iceConnectionState)
		this._handlePeerStreamAdded(this._peer)

		this._peer.on('extendedIceConnectionStateChange', this._handleExtendedIceConnectionStateChangeBound)
	},

	_handleExtendedIceConnectionStateChange: function(extendedIceConnectionState) {
		// Ensure that the name is set, as when the MCU is not used it will
		// not be set later for registered users without microphone nor
		// camera.
		const setNameForUserFromPeerNick = function() {
			if (this._peer.nick !== undefined) {
				this.set('name', this._peer.nick)
			}
		}.bind(this)

		switch (extendedIceConnectionState) {
		case 'new':
			this.set('connectionState', ConnectionState.NEW)
			this.set('audioAvailable', undefined)
			this.set('speaking', undefined)
			this.set('videoAvailable', undefined)
			break
		case 'checking':
			this.set('connectionState', ConnectionState.CHECKING)
			this.set('audioAvailable', undefined)
			this.set('speaking', undefined)
			this.set('videoAvailable', undefined)
			break
		case 'connected':
			this.set('connectionState', ConnectionState.CONNECTED)
			setNameForUserFromPeerNick()
			break
		case 'completed':
			this.set('connectionState', ConnectionState.COMPLETED)
			setNameForUserFromPeerNick()
			break
		case 'disconnected':
			this.set('connectionState', ConnectionState.DISCONNECTED)
			break
		case 'disconnected-long':
			this.set('connectionState', ConnectionState.DISCONNECTED_LONG)
			break
		case 'failed':
			this.set('connectionState', ConnectionState.FAILED)
			break
		case 'failed-no-restart':
			this.set('connectionState', ConnectionState.FAILED_NO_RESTART)
			break
		case 'closed':
			this.set('connectionState', ConnectionState.CLOSED)
			break
		default:
			console.error('Unexpected (extended) ICE connection state: ', extendedIceConnectionState)
		}
	},

	setScreenPeer: function(screenPeer) {
		if (this.get('peerId') !== screenPeer.id) {
			console.warn('Mismatch between stored peer ID and ID of given screen peer: ', this.get('peerId'), screenPeer.id)
		}

		this._screenPeer = screenPeer

		// Reset state that depends on the screen Peer object.
		this._handlePeerStreamAdded(this._screenPeer)
	},

	setUserId: function(userId) {
		this.set('userId', userId)
	},

}
