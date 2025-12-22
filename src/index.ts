// test- ignore me
import { App, LogLevel } from '@slack/bolt';
import * as dotenv from 'dotenv';
import * as fs from 'fs-extra';
import * as path from 'path';

dotenv.config();
// Define channel IDs from env vars
const HELP_CHANNEL = process.env.HELP_CHANNEL!;
const TICKETS_CHANNEL = process.env.TICKETS_CHANNEL!;
const DATA_FILE_PATH = path.join('/app/data', 'ticket-data.json');

// In-memory mapping of ticket message IDs to original message info
interface TicketInfo {
    originalChannel: string;
    originalTs: string;
    ticketMessageTs: string;
    claimers: string[];
    notSure: string[];
}

interface ReactionEvent {
    reaction: string;
    item: {
        channel: string;
        ts: string;
    };
    user: string;
}
interface LBEntry {
    slack_id: string;
    count_of_tickets: number;
}

interface TicketResolution {
    resolver: string;
    timestamp: number; // Unix timestamp in ms
}

const tickets: Record<string, TicketInfo> = {};
// Additional map to quickly look up tickets by original message timestamp
const ticketsByOriginalTs: Record<string, string> = {};

// Historical tracking for leaderboards
let lbForToday: LBEntry[] = [];
let ticketResolutions: TicketResolution[] = [];
// Function to save ticket data to a file
async function saveTicketData() {
    try {
        const data = {
            tickets,
            ticketsByOriginalTs,
            lbForToday,
            ticketResolutions
        };
        await fs.writeJSON(DATA_FILE_PATH, data, { spaces: 2 });
        console.log('Ticket data saved to file');
    } catch (error) {
        console.error('Error saving ticket data to file:', error);
    }
}

// Function to load ticket data from a file
async function loadTicketData() {
    try {
        if (await fs.pathExists(DATA_FILE_PATH)) {
            const data = await fs.readJSON(DATA_FILE_PATH);

            // Clear existing data first
            Object.keys(tickets).forEach(key => delete tickets[key]);
            Object.keys(ticketsByOriginalTs).forEach(key => delete ticketsByOriginalTs[key]);
            lbForToday = [];
            ticketResolutions = [];
            // Load data from file
            if (data.tickets) {
                Object.assign(tickets, data.tickets);
            }
            if (data.ticketsByOriginalTs) {
                Object.assign(ticketsByOriginalTs, data.ticketsByOriginalTs);
            }
            if (data.lbForToday) {
                lbForToday = data.lbForToday;
            }
            if (data.ticketResolutions) {
                ticketResolutions = data.ticketResolutions;
            }

            console.log(`Loaded ${Object.keys(tickets).length} tickets from file`);
            return true;
        }
        return false;
    } catch (error) {
        console.error('Error loading ticket data from file:', error);
        return false;
    }
}

const app = new App({
    token: process.env.SLACK_BOT_TOKEN,
    appToken: process.env.SLACK_APP_TOKEN,
    socketMode: true,
    logLevel: LogLevel.WARN,
});

// Cache of ticket channel members (user IDs)
let ticketChannelMembers: string[] = [];

// Utility: format a Slack timestamp for a URL (remove the decimal point)
function formatTs(ts: string): string {
    return ts.replace('.', '');
}

function createTicketBlocks(originalMessageChannelID: string, originalMessageTs: string, claimText?: string): any[] {
    const headerText = claimText ? claimText : 'Not Claimed';

    // Start with the header section
    const blocks = [
        {
            type: "section",
            text: {
                type: "mrkdwn",
                text: "*" + headerText + "*",
            }
        }
    ];

    // Add action buttons
    blocks.push({
        type: "actions",
        //@ts-ignore
        elements: [
            {
                type: "button",
                style: "primary",
                text: {
                    type: "plain_text",
                    text: "Mark Resolved",
                    emoji: true
                },
                value: "claim_button",
                action_id: "mark_resolved"
            },
            {
                type: "button",
                style: "danger",
                text: {
                    type: "plain_text",
                    text: "Seen, Not Sure",
                    emoji: true
                },
                value: "not_sure_button",
                action_id: "not_sure"
            },
            {
                type: "users_select",
                placeholder: {
                    type: "plain_text",
                    text: "Assign (will DM assignee)",
                    emoji: true
                },
                action_id: "assign_user"
            }
        ]
    });

    // Add thread link
    blocks.push({
        type: "section",
        text: {
            type: "mrkdwn",
            text: `<https://${process.env.SLACK_WORKSPACE_DOMAIN || 'yourworkspace.slack.com'}.slack.com/archives/${originalMessageChannelID}/p${formatTs(originalMessageTs)}|View Thread>`
        }
    });

    return blocks;
}

// Function to refresh the list of ticket channel members
async function refreshTicketChannelMembers(client) {
    try {
        const result = await client.conversations.members({
            channel: TICKETS_CHANNEL
        });

        if (result.ok && result.members) {
            ticketChannelMembers = result.members;
            return true;
        }
        return false;
    } catch (error) {
        console.error("Failed to fetch ticket channel members:", error);
        return false;
    }
}

// Check if a user is a member of the tickets channel
function isTicketChannelMember(userId: string): boolean {
    return ticketChannelMembers.includes(userId);
}

// Function to get a ticket by its original thread timestamp
function getTicketByOriginalTs(originalTs: string): TicketInfo | null {
    const ticketTs = ticketsByOriginalTs[originalTs];
    return ticketTs ? tickets[ticketTs] : null;
}

// Function to get a ticket by its ticket timestamp
function getTicketByTicketTs(ticketTs: string): TicketInfo | null {
    return tickets[ticketTs] || null;
}

// Function to create a ticket
async function createTicket(message: { text: string; ts: string; channel: string; user: string }, client, logger) {
    try {
        // Post the ticket message to the tickets channel
        const result = await client.chat.postMessage({
            text: "Open to view message",
            channel: TICKETS_CHANNEL,
            blocks: createTicketBlocks(message.channel, message.ts)
        });

        if (result.ok && result.ts) {
            // Save mapping of ticket message to original message info
            const ticketInfo: TicketInfo = {
                originalChannel: message.channel,
                originalTs: message.ts,
                ticketMessageTs: result.ts,
                claimers: [],
                notSure: [],
            };

            tickets[result.ts] = ticketInfo;
            ticketsByOriginalTs[message.ts] = result.ts;

            console.info(`Ticket created for message ${message.ts} as ${result.ts}`);

            // Save ticket data after creating a new ticket
            await saveTicketData();

            return ticketInfo;
        }
    } catch (error) {
        logger.error("Error creating ticket:", error);
    }
    return null;
}

// Function to update a ticket message with new information
async function updateTicketMessage(ticket: TicketInfo, client, logger) {
    if (!ticket) return false;

    try {
        // Create claim text based on who has claimed it
        let headerText = 'Not Claimed';

        if (ticket.claimers.length > 0) {
            headerText = `Claimed by: ${ticket.claimers.map(id => `<@${id}>`).join(', ')}`;
        } else if (ticket.notSure.length > 0) {
            headerText = `Not Claimed | Not sure: ${ticket.notSure.map(id => `<@${id}>`).join(', ')}`;
        }

        // Update the ticket message with the current information
        await client.chat.update({
            channel: TICKETS_CHANNEL,
            ts: ticket.ticketMessageTs,
            text: "Open to view message",
            blocks: createTicketBlocks(
                ticket.originalChannel,
                ticket.originalTs,
                headerText
            )
        });

        // Save ticket data after updating a ticket
        await saveTicketData();

        return true;
    } catch (error) {
        logger.error("Error updating ticket message:", error);
        return false;
    }
}

// Function to claim a ticket
async function claimTicket(userId: string, ticketTs: string, client, logger) {
    const ticket = getTicketByTicketTs(ticketTs);
    if (!ticket) return false;

    // Add the user to claimers if not already there
    if (!ticket.claimers.includes(userId)) {
        ticket.claimers.push(userId);
    }

    return await updateTicketMessage(ticket, client, logger);
}

// Function to mark a ticket as "not sure"
async function markTicketAsNotSure(userId: string, ticketTs: string, client, logger) {
    const ticket = getTicketByTicketTs(ticketTs);
    if (!ticket) return false;

    if (!ticket.notSure.includes(userId)) {
        ticket.notSure.push(userId);
    }

    return await updateTicketMessage(ticket, client, logger);
}

// Function to resolve (delete) a ticket
async function resolveTicket(ticketTs: string, resolver: string, client, logger, ai: boolean = false) {
    try {
        logger.info(`[resolveTicket] Starting resolution for ticket ${ticketTs} by ${resolver}`);
        const ticket = getTicketByTicketTs(ticketTs);
        if (!ticket) {
            logger.error(`[resolveTicket] Ticket ${ticketTs} not found in tickets map`);
            return false;
        }
        logger.info(`[resolveTicket] Found ticket: originalChannel=${ticket.originalChannel}, originalTs=${ticket.originalTs}`);
        // Check if the original message still exists before resolving
        try {
            const originalMessageCheck = await client.conversations.history({
                channel: ticket.originalChannel,
                latest: ticket.originalTs,
                inclusive: true,
                limit: 1
            });

            // If the message doesn't exist or we couldn't find it, log and continue with resolution
            if (!originalMessageCheck.ok || !originalMessageCheck.messages || originalMessageCheck.messages.length === 0) {
                logger.warn(`Original message for ticket ${ticketTs} no longer exists or is inaccessible. Proceeding with ticket resolution.`);
            } else {
                // Reply to the original thread to notify the user
                try {
                    await client.chat.postMessage({
                        channel: ticket.originalChannel,
                        thread_ts: ticket.originalTs,
                        text: `:white_check_mark: This ticket has been marked as resolved. Please send a new message in <#${HELP_CHANNEL}> to create a new ticket if you have another question. ${ai ? "" : "You're welcome to continue asking follow-up questions in this thread!"}`
                    });
                } catch (postError) {
                    logger.warn(`Failed to post resolution message:`, postError);
                }
                
                // Add a checkmark reaction to the original message
                try {
                    await client.reactions.add({
                        name: "white_check_mark",
                        timestamp: ticket.originalTs,
                        channel: ticket.originalChannel,
                    });
                } catch (reactionError) {
                    logger.warn(`Failed to add reaction to original message:`, reactionError);
                }
            }
        } catch (error) {
            logger.warn(`Failed to check original message for ticket ${ticketTs}:`, error);
            // Continue with resolution even if we can't verify the original message
        }

        // Delete the ticket message from the tickets channel
        logger.info(`[resolveTicket] Deleting ticket message from tickets channel`);
        await client.chat.delete({
            channel: TICKETS_CHANNEL,
            ts: ticketTs
        });
        logger.info(`[resolveTicket] Ticket message deleted successfully`);

        // Clean up our records
        delete ticketsByOriginalTs[ticket.originalTs];
        delete tickets[ticketTs];
        logger.info(`[resolveTicket] Cleaned up ticket records`);
        
        // Track resolution for leaderboards
        ticketResolutions.push({
            resolver,
            timestamp: Date.now()
        });
        
        const newEntry = Array.from(lbForToday);
        const existingEntryIndex = newEntry.findIndex(e => e.slack_id === resolver);
        if (existingEntryIndex !== -1) {
            newEntry[existingEntryIndex].count_of_tickets += 1;
        } else {
            newEntry.push({
                slack_id: resolver,
                count_of_tickets: 1
            });
        }
        lbForToday = newEntry;
        // Save ticket data after resolving a ticket
        await saveTicketData();

        return true;
    } catch (error) {
        logger.error("Error resolving ticket:", error);
        return false;
    }
}

// Listen for messages in the help channel to create tickets
app.event('message', async ({ event, client, logger }) => {
    if (event.channel !== HELP_CHANNEL || (event as any).thread_ts) return;
    
    // but allow images uploads 
    if ((event as any).subtype && (event as any).subtype !== 'file_share') return;

    const message = event as { text: string; ts: string; channel: string; user: string };
    
    // non-empty text
    if (!message.text && (event as any).subtype === 'file_share') {
        message.text = "[Image/File uploaded]";
    }
    
    await createTicket(message, client, logger);
    // send message
    await client.chat.postMessage({
        channel: event.channel,
        thread_ts: event.ts,
        text: `:rac_woah: woah... a new ticket?? someone will be here to help you soon... make sure to read the <https://hackclub.enterprise.slack.com/docs/T0266FRGM/F09LT3JBG3C|FAQ> to see if it answers your question!`
    });
    await client.chat.postMessage({
        channel: event.channel,
        thread_ts: event.ts,
        text: `if you have discovered the solution to your issue, react with a :white_tick: (white_tick) to mark it as solved!`,
        emoji: true
    })
});

// Listen for thread replies in the help channel to handle claims
app.event('message', async ({ event, client, logger }) => {
    // Only process thread replies in the help channel
    if (!((event as any).thread_ts) || event.channel !== HELP_CHANNEL || (event as any).thread_ts === event.ts) return;
    if ((event as any).subtype) return; // Skip edited messages, etc.

    const threadReply = event as { thread_ts: string; user: string };

    // Skip if user is not a member of the tickets channel
    if (!isTicketChannelMember(threadReply.user)) {
        logger.info(`User ${threadReply.user} tried to claim a ticket but is not in the tickets channel`);
        return;
    }

    // Get the ticket by the original thread timestamp
    const ticket = getTicketByOriginalTs(threadReply.thread_ts);

    if (ticket) {
        // Use the claimTicket function to claim the ticket
        const success = await claimTicket(threadReply.user, ticket.ticketMessageTs, client, logger);
        if (success) {
            logger.info(`Ticket ${ticket.ticketMessageTs} claimed by ${threadReply.user}`);
        }
    }
});

// Handle button action "Mark Resolved"
app.action('mark_resolved', async ({ body, ack, client, logger }) => {
    await ack();

    try {
        const userId = (body.user || {}).id;
        logger.info(`[mark_resolved] User ${userId} clicked Mark Resolved button`);
        
        // Skip if user is not a member of the tickets channel
        if (!isTicketChannelMember(userId)) {
            logger.warn(`[mark_resolved] User ${userId} is not in tickets channel, aborting`);
            return;
        }

        const ticketTs = (body as any).message?.ts;
        if (!ticketTs) {
            logger.error(`[mark_resolved] No ticket timestamp found in message`);
            return;
        }

        logger.info(`[mark_resolved] Attempting to resolve ticket ${ticketTs}`);
        const success = await resolveTicket(ticketTs, userId, client, logger);
        if (success) {
            logger.info(`[mark_resolved] SUCCESS: Ticket ${ticketTs} marked as resolved by ${userId}`);
        } else {
            logger.error(`[mark_resolved] FAILED: Ticket ${ticketTs} could not be resolved`);
        }
    } catch (error) {
        logger.error(`[mark_resolved] Unexpected error:`, error);
    }
});

// Handle button action "Seen, Not Sure"
app.action('not_sure', async ({ body, ack, client, logger }) => {
    await ack();

    const ticketTs = (body as any).message?.ts;
    const userId = (body.user || {}).id;

    if (!ticketTs || !userId) return;

    // Skip if user is not a member of the tickets channel
    if (!isTicketChannelMember(userId)) {
        logger.info(`User ${userId} tried to mark "not sure" but is not in the tickets channel`);
        return;
    }

    const success = await markTicketAsNotSure(userId, ticketTs, client, logger);
    if (success) {
        logger.info(`Ticket ${ticketTs} marked as "not sure" by ${userId}`);
    }
});

// Handle assign user action
app.action('assign_user', async ({ body, ack, client, logger }) => {
    await ack();

    const userId = (body.user || {}).id;
    // Skip if user is not a member of the tickets channel
    if (!isTicketChannelMember(userId)) {
        logger.info(`User ${userId} tried to assign a ticket but is not in the tickets channel`);
        return;
    }

    const ticketTs = (body as any).message?.ts;
    const selectedUser = (body as any).actions?.[0]?.selected_user as string;

    if (!ticketTs || !selectedUser) return;

    const ticket = getTicketByTicketTs(ticketTs);
    if (!ticket) return;


    try {
        // DM the assigned user
        await client.chat.postMessage({
            channel: selectedUser,
            text: `You have been assigned a ticket from <#${TICKETS_CHANNEL}>. Please check it out & claim it by replying.\n<https://${process.env.SLACK_WORKSPACE_DOMAIN || 'yourworkspace.slack.com'}.slack.com/archives/${TICKETS_CHANNEL}/p${formatTs(ticket.ticketMessageTs)}|View Ticket>`
        });

        logger.info(`User ${selectedUser} was assigned ticket ${ticketTs}`);
    } catch (error) {
        logger.error(error);
    }
});

// Listen for reaction added events to resolve tickets
app.event('reaction_added', async ({ event, client, logger }) => {
    const reactionEvent = event as ReactionEvent;

    // Skip if user is not a member of the tickets channel
    if (!isTicketChannelMember(reactionEvent.user)) {
        logger.info(`User ${reactionEvent.user} tried to resolve a ticket via reaction but is not in the tickets channel`);
        return;
    }

    // Check for the check mark reaction in the help channel
    if (reactionEvent.reaction === 'white_check_mark' && reactionEvent.item.channel === HELP_CHANNEL) {
        // Get the ticket by its original timestamp
        const ticket = getTicketByOriginalTs(reactionEvent.item.ts);
        if (!ticket) return;

        // Allow resolving if:
        // 1. User is the original message author, OR
        // 2. User is in the tickets channel
        try {
            // Get the original message to check the author
            const messageInfo = await client.conversations.history({
                channel: reactionEvent.item.channel,
                latest: reactionEvent.item.ts,
                limit: 1,
                inclusive: true
            });

            const isOriginalAuthor = messageInfo.messages &&
                messageInfo.messages[0] &&
                messageInfo.messages[0].user === reactionEvent.user;

            if (isOriginalAuthor || isTicketChannelMember(reactionEvent.user)) {
                const success = await resolveTicket(ticket.ticketMessageTs, reactionEvent.user, client, logger);
                if (success) {
                    logger.info(`Ticket resolved via reaction by ${reactionEvent.user} (${isOriginalAuthor ? 'original author' : 'support team member'})`);
                    try {
                        client.reactions.add({
                            name: "white_check_mark",
                            timestamp: reactionEvent.item.ts,
                            channel: reactionEvent.item.channel,
                        });
                    } catch (error) {
                        logger.error("Error adding reaction:", error);
                    }
                }
            } else {
                logger.info(`User ${reactionEvent.user} tried to resolve a ticket via reaction but is not authorized`);
            }
        } catch (error) {
            logger.error("Error checking message author:", error);
        }
    }
});

async function sendLB() {
    app.client.chat.postMessage({
        channel: TICKETS_CHANNEL,
        text: `Todays top 10 for ticket closes:\n${lbForToday.sort((a, b) => b.count_of_tickets - a.count_of_tickets).map((e, i) => `${i + 1} - <@${e.slack_id}> resolved *${e.count_of_tickets}* today!\n`)}`
    })
    lbForToday = []
    saveTicketData()
}

// Helper functions for leaderboard calculations
function getLeaderboard(resolutions: TicketResolution[], since?: number): { userId: string; count: number }[] {
    const filtered = since 
        ? resolutions.filter(r => r.timestamp >= since)
        : resolutions;
    
    const counts: Record<string, number> = {};
    for (const r of filtered) {
        counts[r.resolver] = (counts[r.resolver] || 0) + 1;
    }
    
    return Object.entries(counts)
        .map(([userId, count]) => ({ userId, count }))
        .sort((a, b) => b.count - a.count);
}

function getStartOfToday(): number {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
}

function getStartOf7DaysAgo(): number {
    return Date.now() - (7 * 24 * 60 * 60 * 1000);
}

// App Home handler - only shows to members of the staff channel
const STAFF_HOME_CHANNEL = 'C0A4VNM716J';

app.event('app_home_opened', async ({ event, client, logger }) => {
    try {
        // Check if user is a member of the staff channel
        let isStaffMember = false;
        try {
            const membersResult = await client.conversations.members({
                channel: STAFF_HOME_CHANNEL
            });
            isStaffMember = membersResult.members?.includes(event.user) || false;
        } catch (e) {
            logger.warn('Failed to check staff channel membership');
        }

        // Show restricted view for non-staff
        if (!isStaffMember) {
            await client.views.publish({
                user_id: event.user,
                view: {
                    type: "home",
                    blocks: [
                        {
                            type: "header",
                            text: {
                                type: "plain_text",
                                text: "heidi, the dealer"
                            }
                        },
                        {
                            type: "section",
                            text: {
                                type: "mrkdwn",
                                text: "there's no tickets here, because you aren't a helper! huzzah, no stress!! :huzzah:",
                                emoji: true
                            }
                        }
                    ]
                }
            });
            return;
        }

        const todayLeaderboard = getLeaderboard(ticketResolutions, getStartOfToday());
        const weekLeaderboard = getLeaderboard(ticketResolutions, getStartOf7DaysAgo());
        const allTimeLeaderboard = getLeaderboard(ticketResolutions);
        
        const unclaimed = Object.values(tickets).filter(t => t.claimers.length === 0);
        
        const formatLeader = (lb: { userId: string; count: number }[], emoji: string) => {
            if (lb.length === 0) return '_No one yet!_';
            const top = lb[0]!;
            return `${emoji} <@${top.userId}> with *${top.count}* ticket${top.count === 1 ? '' : 's'}`;
        };
        
        const formatTop5 = (lb: { userId: string; count: number }[]) => {
            if (lb.length === 0) return '_No resolutions yet_';
            return lb.slice(0, 5)
                .map((entry, i) => `${i + 1}. <@${entry.userId}> - ${entry.count}`)
                .join('\n');
        };

        const blocks: any[] = [
            {
                type: "header",
                text: {
                    type: "plain_text",
                    text: "heidi, the dealer",
                    emoji: true
                }
            },
            {
                type: "section",
                text: {
                    type: "mrkdwn",
                    text: "welcome to the poker table, here's what's happening"
                }
            },
            { type: "divider" },
            {
                type: "header",
                text: {
                    type: "plain_text",
                    text: "leaderboard",
                    emoji: true
                }
            },
            {
                type: "section",
                text: {
                    type: "mrkdwn",
                    text: `*most solved tickets today:*\n${formatLeader(todayLeaderboard, '🎯')}`
                }
            },
            {
                type: "section",
                text: {
                    type: "mrkdwn",
                    text: `*most solved tickets in past 7d:*\n${formatLeader(weekLeaderboard, '🔥')}`
                }
            },
            {
                type: "section",
                text: {
                    type: "mrkdwn",
                    text: `*most solved tickets (all time):*\n${formatLeader(allTimeLeaderboard, '👑')}`
                }
            },
            { type: "divider" },
            {
                type: "header",
                text: {
                    type: "plain_text",
                    text: "top 5 of all time",
                    emoji: true
                }
            },
            {
                type: "section",
                text: {
                    type: "mrkdwn",
                    text: formatTop5(allTimeLeaderboard)
                }
            },
            { type: "divider" },
            {
                type: "header",
                text: {
                    type: "plain_text",
                    text: `unclaimed tickets: (${unclaimed.length})`,
                    emoji: true
                }
            }
        ];

        if (unclaimed.length === 0) {
            blocks.push({
                type: "section",
                text: {
                    type: "mrkdwn",
                    text: "all tickets are claimed! yay :3"
                }
            });
        } else {
            const ticketList = unclaimed.slice(0, 10).map(t => 
                `• <https://${process.env.SLACK_WORKSPACE_DOMAIN || 'yourworkspace.slack.com'}.slack.com/archives/${t.originalChannel}/p${formatTs(t.originalTs)}|poke at ticket>`
            ).join('\n');
            
            blocks.push({
                type: "section",
                text: {
                    type: "mrkdwn",
                    text: ticketList + (unclaimed.length > 10 ? `\n_...and ${unclaimed.length - 10} more_` : '')
                }
            });
        }

        await client.views.publish({
            user_id: event.user,
            view: {
                type: "home",
                blocks
            }
        });
    } catch (error) {
        logger.error("Error publishing App Home:", error);
    }
});

// Start the app
(async () => {
    // Load ticket data from file before starting the app
    await loadTicketData();

    await app.start();

    // Initialize the ticket channel members cache
    const client = app.client;
    await refreshTicketChannelMembers(client);

    // Refresh the ticket channel members list every hour
    setInterval(() => refreshTicketChannelMembers(client), 60 * 60 * 1000);

    // Periodically save ticket data (every 5 minutes as a backup)
    setInterval(saveTicketData, 5 * 60 * 1000);

    // interval to send lb
    setInterval(sendLB, 24*60*60*1000)
    console.log(`⚡️ Slack Bolt app is running!`);
})();
