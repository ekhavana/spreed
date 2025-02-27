<!--
  - @copyright Copyright (c) 2019 Marco Ambrosini <marcoambrosini@pm.me>
  -
  - @author Marco Ambrosini <marcoambrosini@pm.me>
  -
  - @license GNU AGPL version 3 or any later version
  -
  - This program is free software: you can redistribute it and/or modify
  - it under the terms of the GNU Affero General Public License as
  - published by the Free Software Foundation, either version 3 of the
  - License, or (at your option) any later version.
  -
  - This program is distributed in the hope that it will be useful,
  - but WITHOUT ANY WARRANTY; without even the implied warranty of
  - MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
  - GNU Affero General Public License for more details.
  -
  - You should have received a copy of the GNU Affero General Public License
  - along with this program. If not, see <http://www.gnu.org/licenses/>.
-->

<template>
	<Content
		v-shortkey="['ctrl', 'f']"
		:class="{ 'icon-loading': loading, 'in-call': isInCall }"
		app-name="talk"
		@shortkey.native="handleAppSearch">
		<LeftSidebar v-if="getUserId && !isFullscreen" />
		<AppContent>
			<router-view />
		</AppContent>
		<RightSidebar
			:show-chat-in-sidebar="isInCall" />
		<PreventUnload :when="isInCall" />
	</Content>
</template>

<script>
import AppContent from '@nextcloud/vue/dist/Components/AppContent'
import Content from '@nextcloud/vue/dist/Components/Content'
import LeftSidebar from './components/LeftSidebar/LeftSidebar'
import PreventUnload from 'vue-prevent-unload'
import Router from './router/router'
import RightSidebar from './components/RightSidebar/RightSidebar'
import { EventBus } from './services/EventBus'
import { getCurrentUser } from '@nextcloud/auth'
import { fetchConversation } from './services/conversationsService'
import {
	joinConversation,
	leaveConversationSync,
} from './services/participantsService'
import { PARTICIPANT } from './constants'
import {
	connectSignaling,
	getSignalingSync,
} from './utils/webrtc/index'
import { emit } from '@nextcloud/event-bus'
import browserCheck from './mixins/browserCheck'

export default {
	name: 'App',
	components: {
		AppContent,
		Content,
		LeftSidebar,
		PreventUnload,
		RightSidebar,
	},

	mixins: [browserCheck],

	data: function() {
		return {
			savedLastMessageMap: {},
			defaultPageTitle: false,
			loading: false,
		}
	},

	computed: {
		windowIsVisible() {
			return this.$store.getters.windowIsVisible()
		},
		isFullscreen() {
			return this.$store.getters.isFullscreen()
		},

		getUserId() {
			return this.$store.getters.getUserId()
		},

		participant() {
			if (typeof this.token === 'undefined') {
				return {
					inCall: PARTICIPANT.CALL_FLAG.DISCONNECTED,
				}
			}

			const participantIndex = this.$store.getters.getParticipantIndex(this.token, this.$store.getters.getParticipantIdentifier())
			if (participantIndex !== -1) {
				return this.$store.getters.getParticipant(this.token, participantIndex)
			}

			return {
				inCall: PARTICIPANT.CALL_FLAG.DISCONNECTED,
			}
		},

		isInCall() {
			return this.participant.inCall !== PARTICIPANT.CALL_FLAG.DISCONNECTED
		},

		/**
		 * Keeps a list for all last message ids
		 * @returns {object} Map with token => lastMessageId
		 */
		lastMessageMap() {
			const conversationList = this.$store.getters.conversationsList
			if (conversationList.length === 0) {
				return {}
			}

			const lastMessage = {}
			conversationList.forEach(conversation => {
				lastMessage[conversation.token] = 0 + (conversation.lastMessage && conversation.lastMessage.id ? conversation.lastMessage.id : 0)
			})
			return lastMessage
		},

		/**
		 * @returns {boolean} Returns true, if
		 * - a conversation is newly added to lastMessageMap
		 * - a conversation has a different last message id then previously
		 */
		atLeastOneLastMessageIdChanged() {
			let modified = false
			Object.keys(this.lastMessageMap).forEach(token => {
				if (!this.savedLastMessageMap[token]
					|| this.savedLastMessageMap[token] !== this.lastMessageMap[token]) {
					modified = true
				}
			})

			return modified
		},

		/**
		 * The current conversation token
		 * @returns {string} The token.
		 */
		token() {
			return this.$store.getters.getToken()
		},
	},

	watch: {
		atLeastOneLastMessageIdChanged() {
			if (this.windowIsVisible) {
				return
			}

			this.setPageTitle(this.getConversationName(this.token), this.atLeastOneLastMessageIdChanged)
		},
	},

	beforeDestroy() {
		if (!getCurrentUser()) {
			EventBus.$off('shouldRefreshConversations', this.refreshCurrentConversation)
		}
		document.removeEventListener('visibilitychange', this.changeWindowVisibility)
	},

	beforeMount() {
		if (!getCurrentUser()) {
			EventBus.$once('joinedConversation', () => {
				this.fixmeDelayedSetupOfGuestUsers()
			})
			EventBus.$on('shouldRefreshConversations', this.refreshCurrentConversation)
		}

		if (this.$route.name === 'conversation') {
			// Update current token in the token store
			this.$store.dispatch('updateToken', this.$route.params.token)
			// Automatically join the conversation as well
			joinConversation(this.$route.params.token)
		}

		// FIXME Signaling should be done on conversation level, as the signaling information depends on it.
		// FIXME This was just added as a quick hack because of timing
		connectSignaling()

		window.addEventListener('resize', this.onResize)
		document.addEventListener('visibilitychange', this.changeWindowVisibility)

		this.onResize()

		window.addEventListener('unload', () => {
			console.info('Navigating away, leaving conversation')
			if (this.token) {
				// We have to do this synchronously, because in unload and beforeunload
				// Promises, async and await are prohibited.
				const signaling = getSignalingSync()
				if (signaling) {
					signaling.disconnect()
				}
				leaveConversationSync(this.token)
			}
		})

		EventBus.$on('conversationsReceived', (params) => {
			if (this.$route.name === 'conversation'
				&& !this.$store.getters.conversation(this.token)) {
				if (!params.singleConversation) {
					console.info('Conversations received, but the current conversation is not in the list, trying to get potential public conversation manually')
					this.refreshCurrentConversation()
				} else {
					console.info('Conversation received, but the current conversation is not in the list. Redirecting to /apps/spreed')
					this.$router.push('/apps/spreed/not-found')
				}
			}
		})

		/**
		 * Listens to the conversationsReceived globalevent, emitted by the conversationsList
		 * component each time a new batch of conversations is received and processed in
		 * the store.
		 */
		EventBus.$once('conversationsReceived', () => {
			if (this.$route.name === 'conversation') {
				// Adjust the page title once the conversation list is loaded
				this.setPageTitle(this.getConversationName(this.token), false)
			}

			if (!getCurrentUser()) {
				// Set the current actor/participant for guests
				const conversation = this.$store.getters.conversation(this.token)
				this.$store.dispatch('setCurrentParticipant', conversation)
			}
		})

		const beforeRouteChangeListener = (to, from, next) => {
			/**
			 * This runs whenever the new route is a conversation.
			 */
			if (to.name === 'conversation') {
				// Page title
				const nextConversationName = this.getConversationName(to.params.token)
				this.setPageTitle(nextConversationName)
				// Update current token in the token store
				this.$store.dispatch('updateToken', to.params.token)
			}
			/**
			 * Fires a global event that tells the whole app that the route has changed. The event
			 * carries the from and to objects as payload
			 */
			EventBus.$emit('routeChange', { from, to })

			next()
		}

		/**
		 * Global before guard, this is called whenever a navigation is triggered.
		*/
		Router.beforeEach((to, from, next) => {
			if (this.isInCall) {
				OC.dialogs.confirmDestructive(
					t('spreed', 'Navigating away from the page will leave the call in {conversation}', {
						conversation: this.getConversationName(this.token),
					}),
					t('spreed', 'Leave call'),
					{
						type: OC.dialogs.YES_NO_BUTTONS,
						confirm: t('spreed', 'Leave call'),
						confirmClasses: 'error',
						cancel: t('spreed', 'Stay in call'),
					},
					(decision) => {
						if (!decision) {
							return
						}

						beforeRouteChangeListener(to, from, next)
					}
				)
			} else {
				beforeRouteChangeListener(to, from, next)
			}
		})

		if (getCurrentUser()) {
			console.debug('Setting current user')
			this.$store.dispatch('setCurrentUser', getCurrentUser())
		} else {
			console.debug('Can not set current user because it\'s a guest')
		}
	},

	mounted() {
		// see browserCheck mixin
		this.checkBrowser()
	},

	methods: {
		fixmeDelayedSetupOfGuestUsers() {
			// FIXME Refresh the data now that the user joined the conversation
			// The join request returns this data already, but it's lost in the signaling code
			this.refreshCurrentConversation()

			window.setInterval(() => {
				this.refreshCurrentConversation()
			}, 30000)
		},

		refreshCurrentConversation() {
			this.fetchSingleConversation(this.token)
		},

		changeWindowVisibility() {
			this.$store.dispatch('setWindowVisibility', !document.hidden)
			if (this.windowIsVisible) {
				// Remove the potential "*" marker for unread chat messages
				this.setPageTitle(this.getConversationName(this.token), false)
			} else {
				// Copy the last message map to the saved version,
				// this will be our reference to check if any chat got a new
				// message since the last visit
				this.savedLastMessageMap = this.lastMessageMap
			}
		},

		/**
		 * Set the page title to the conversation name
		 * @param {string} title Prefix for the page title e.g. conversation name
		 * @param {boolean} showAsterix Prefix for the page title e.g. conversation name
		 */
		setPageTitle(title, showAsterix) {
			if (this.defaultPageTitle === false) {
				// On the first load we store the current page title "Talk - Nextcloud",
				// so we can append it every time again
				this.defaultPageTitle = window.document.title
				// When a conversation is opened directly, the "Talk - " part is
				// missing from the title
				if (this.defaultPageTitle.indexOf(t('spreed', 'Talk') + ' - ') !== 0) {
					this.defaultPageTitle = t('spreed', 'Talk') + ' - ' + this.defaultPageTitle
				}
			}

			if (title !== '') {
				window.document.title = (showAsterix ? '* ' : '') + `${title} - ${this.defaultPageTitle}`
			} else {
				window.document.title = (showAsterix ? '* ' : '') + this.defaultPageTitle
			}
		},

		onResize() {
			this.windowHeight = window.innerHeight - document.getElementById('header').clientHeight
		},

		/**
		 * Get a conversation's name.
		 * @param {string} token The conversation's token
		 * @returns {string} The conversation's name
		 */
		getConversationName(token) {
			if (!this.$store.getters.conversation(this.token)) {
				return ''
			}

			return this.$store.getters.conversation(this.token).displayName
		},

		async fetchSingleConversation(token) {
			try {
				/**
				 * Fetches the conversations from the server and then adds them one by one
				 * to the store.
				 */
				const response = await fetchConversation(token)

				// this.$store.dispatch('purgeConversationsStore')
				this.$store.dispatch('addConversation', response.data.ocs.data)
				this.$store.dispatch('markConversationRead', token)

				/**
				 * Emits a global event that is used in App.vue to update the page title once the
				 * ( if the current route is a conversation and once the conversations are received)
				 */
				EventBus.$emit('conversationsReceived', {
					singleConversation: true,
				})
			} catch (exception) {
				console.info('Conversation received, but the current conversation is not in the list. Redirecting to /apps/spreed')
				this.$router.push('/apps/spreed/not-found')
				this.$store.dispatch('hideSidebar')
			}
		},
		// Upon pressing ctrl+f, focus the search box in the left sidebar
		handleAppSearch() {
			emit('toggle-navigation', {
				open: true,
			})
			document.querySelector('.conversations-search')[0].focus()
		},
	},
}
</script>

<style lang="scss" scoped>
#content {
	height: 100%;

	&.in-call {
		::v-deep #app-navigation-toggle:before {
			/* Force white handle when inside a call */
			color: #FFFFFF;
		}
	}
}
</style>
