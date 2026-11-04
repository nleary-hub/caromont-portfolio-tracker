/**
 * The three pages anyone can open without signing in: About (the home page Google's OAuth branding asks for), Privacy
 * and Terms. Google won't publish the OAuth app (which stops its Drive refresh token expiring every 7 days) without a
 * public home page, privacy policy and terms of service on the app's own domain. Wording is plain and describes only
 * what the app does; it makes no legal or compliance claims, and CaroMont legal or compliance may want to revise it.
 */
export interface PublicSection {
  heading: string;
  paragraphs: string[];
}

export interface PublicPage {
  path: string;
  title: string;
  intro: string;
  sections: PublicSection[];
}

export class PublicPages {
  static readonly APP_NAME = "Service Line Portfolio Tracker";
  static readonly UPDATED = "November 3, 2026";
  /** proxy.ts keeps these paths (exactly) outside sign-in. */
  static readonly PATHS = ["/about", "/privacy", "/terms"] as const;

  static readonly ABOUT: PublicPage = {
    path: "/about",
    title: "Service Line Portfolio Tracker",
    intro:
      "An internal tool for CaroMont Health's cardiovascular and pulmonary service line. It keeps the service line's projects in one place and produces a status report every two weeks.",
    sections: [
      {
        heading: "What it does",
        paragraphs: [
          "Project owners and leaders record each project's status, milestones, due dates and blockers. The tracker shows the whole portfolio on one screen, keeps a history of changes, and freezes a status report every two weeks.",
          "Each report is saved as a PDF to the app owner's Google Drive. If that save fails, the report is shared through a link that expires after seven days.",
        ],
      },
      {
        heading: "Who can use it",
        paragraphs: [
          "Only people the app's administrators have approved can sign in, with their Google account or an email and password an administrator set up. There is no public sign-up.",
        ],
      },
    ],
  };

  static readonly PRIVACY: PublicPage = {
    path: "/privacy",
    title: "Privacy policy",
    intro: "This page explains what information the Service Line Portfolio Tracker keeps, why, and who it goes to.",
    sections: [
      {
        heading: "What the app keeps",
        paragraphs: [
          "Sign-in details: when you sign in with Google, the app receives your name, email address and whether Google has verified that address, and uses them only to check that you're allowed in. If you sign in with an email and password, the app stores the email and a hashed form of the password, never the password itself.",
          "Project information: what people enter about the service line's projects, such as names, owners, milestones, dates, notes and blockers, and a history of who changed what and when.",
          "Sign-in cookies: the app sets cookies only to keep you signed in. It uses no advertising or tracking cookies.",
        ],
      },
      {
        heading: "Google account data",
        paragraphs: [
          "Google sign-in gives the app only your basic profile: name, email address and its verified status.",
          "Separately, the app owner has allowed the app to save the biweekly report to their own Google Drive. That permission only lets the app create files and use the files it created. It can't see or open anything else in that Drive.",
          "Information from Google is used only for these two purposes. It isn't sold, used for advertising, or used to train AI models.",
        ],
      },
      {
        heading: "Who else handles it",
        paragraphs: [
          "The app runs on Vercel, and its data is stored in a Neon Postgres database.",
          "When the app owner uses one of the app's optional AI tools, the text for that request is sent to the AI provider the owner chose (OpenAI, Anthropic or xAI) to produce the answer.",
          "If someone connects Claude to the tracker through its Claude connector, Claude can read and update project information as that person, with the same access they have.",
          "Error reports go to Sentry with personal information removed, so problems can be found and fixed.",
          "Information isn't sold or shared with anyone else.",
        ],
      },
      {
        heading: "Patient information",
        paragraphs: ["The tracker is for project information. It isn't designed to hold patient information, so please don't enter any."],
      },
      {
        heading: "Questions and changes",
        paragraphs: [
          "To ask about your information, or to have your access or details removed, contact the app's administrator at CaroMont Health.",
          "If this policy changes, the date at the top of this page changes with it.",
        ],
      },
    ],
  };

  static readonly TERMS: PublicPage = {
    path: "/terms",
    title: "Terms of service",
    intro: "These terms cover using the Service Line Portfolio Tracker.",
    sections: [
      {
        heading: "Who may use it",
        paragraphs: [
          "The tracker is for people at CaroMont Health whom its administrators have approved, for service line work. Administrators can change or remove anyone's access at any time.",
        ],
      },
      {
        heading: "Using it well",
        paragraphs: [
          "Keep your sign-in to yourself.",
          "Enter information that's accurate and about the service line's work. Don't enter patient information.",
          "Don't try to reach parts of the app or data that you haven't been given access to.",
        ],
      },
      {
        heading: "The service",
        paragraphs: [
          "The tracker is provided as is, as an internal tool. It may change, pause or stop without notice, so keep anything you can't afford to lose somewhere else as well.",
          "If these terms change, the date at the top of this page changes with them. Questions go to the app's administrator at CaroMont Health.",
        ],
      },
    ],
  };

  static readonly ALL: PublicPage[] = [PublicPages.ABOUT, PublicPages.PRIVACY, PublicPages.TERMS];
}
