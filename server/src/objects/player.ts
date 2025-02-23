import {
    type Body,
    Circle,
    Vec2
} from "planck";
import type { WebSocket } from "uWebSockets.js";

import { type CollisionFilter, GameObject } from "../types/gameObject";
import { SuroiBitStream } from "../../../common/src/utils/suroiBitStream";
import { type Game } from "../game";
import { endGame, type PlayerContainer } from "../server";
import { type SendingPacket } from "../types/sendingPacket";

import { ObjectType } from "../../../common/src/utils/objectType";
import {
    ANIMATION_TYPE_BITS,
    AnimationType,
    ObjectCategory,
    PLAYER_RADIUS
} from "../../../common/src/constants";
import { DeathMarker } from "./deathMarker";
import { GameOverPacket } from "../packets/sending/gameOverPacket";
import { KillPacket } from "../packets/sending/killPacket";
import { CircleHitbox } from "../../../common/src/utils/hitbox";
import { type MeleeDefinition } from "../../../common/src/definitions/melees";
import { type GunDefinition } from "../../../common/src/definitions/guns";
import { Inventory } from "../inventory/inventory";
import { type InventoryItem } from "../inventory/inventoryItem";
import { KillFeedPacket } from "../packets/sending/killFeedPacket";
import { KillKillFeedMessage } from "../types/killFeedMessage";
import { type Action } from "../inventory/action";

export class Player extends GameObject {
    override readonly is: CollisionFilter = {
        player: true,
        obstacle: false,
        bullet: false,
        loot: false
    };

    override readonly collidesWith: CollisionFilter = {
        player: false,
        obstacle: true,
        bullet: true,
        loot: false
    };

    readonly damageable = true;

    name: string;

    joined = false;
    disconnected = false;

    private _health = 100;

    private _adrenaline = 0;

    killedBy?: Player;

    kills = 0;
    damageDone = 0;
    damageTaken = 0;
    joinTime: number;

    lastInteractionTime = Date.now();

    readonly recoil = {
        active: false,
        time: 0,
        multiplier: 1
    };

    get isMoving(): boolean {
        return this.movement.up ||
            this.movement.down ||
            this.movement.left ||
            this.movement.right ||
            this.movement.moving;
    }

    movesSinceLastUpdate = 0;

    readonly movement = {
        up: false,
        down: false,
        left: false,
        right: false,
        // mobile
        moving: false,
        angle: 0
    };

    isMobile!: boolean;

    /**
     * Whether the player is attacking as of last update
     */
    attacking = false;

    /**
     * Whether the player started attacking last update
     */
    startedAttacking = false;

    /**
     * Whether the player is turning as of last update
     */
    turning = false;

    /**
     * The position this player died at, if applicable
     */
    deathPosition?: Vec2;

    /**
     * Keeps track of various fields which are "dirty"
     * and therefore need to be sent to the client for
     * updating
     */
    readonly dirty = {
        health: true,
        adrenaline: true,
        activeWeaponIndex: true,
        weapons: true,
        inventory: true,
        activePlayerId: true,
        zoom: true,
        action: false
    };

    readonly inventory = new Inventory(this);

    get activeItem(): InventoryItem {
        return this.inventory.activeWeapon;
    }

    get activeItemIndex(): number {
        return this.inventory.activeWeaponIndex;
    }

    hitEffect = false;

    animation = {
        type: AnimationType.None,
        // This boolean is flipped when an animation plays
        // when its changed the client plays the animation
        seq: false
    };

    visibleObjects = new Set<GameObject>(); // Objects the player can see
    nearObjects = new Set<GameObject>(); // Objects the player can see with a 1x scope
    partialDirtyObjects = new Set<GameObject>(); // Objects that need to be partially updated
    fullDirtyObjects = new Set<GameObject>(); // Objects that need to be fully updated
    deletedObjects = new Set<GameObject>(); // Objects that need to be deleted

    private _zoom!: number;
    xCullDist!: number;
    yCullDist!: number;

    socket: WebSocket<PlayerContainer>;

    fullUpdate = true;

    body: Body;

    action: Action | undefined;

    isDev: boolean;

    nameColor: string;

    /**
     * Used to make players invunerable for 5 seconds after spawning or until they move
     */
    invulnerable = true;

    /**
     * Determines if the player can despawn
     * Set to false once the player picks up loot
     */
    canDespawn = true;

    constructor(game: Game, name: string, socket: WebSocket<PlayerContainer>, position: Vec2, isDev: boolean, nameColor: string) {
        super(game, ObjectType.categoryOnly(ObjectCategory.Player), position);

        this.isDev = isDev;
        this.nameColor = nameColor;

        this.socket = socket;
        this.name = name;
        this.rotation = 0;
        this.zoom = 48;
        // fixme    ^^ magic number

        this.joinTime = game.now;

        // Init body
        this.body = game.world.createBody({
            type: "dynamic",
            position,
            fixedRotation: true
        });

        this.body.createFixture({
            shape: Circle(PLAYER_RADIUS),
            friction: 0.0,
            density: 1000.0,
            restitution: 0.0,
            userData: this
        });

        this.hitbox = new CircleHitbox(PLAYER_RADIUS, this.position);

        // Inventory preset
        /*if (this.isDev) {
            this.inventory.addOrReplaceWeapon(0, "deathray");
            (this.inventory.getWeapon(0) as GunItem).ammo = 255;
            this.inventory.addOrReplaceWeapon(1, "tango_51");
            (this.inventory.getWeapon(1) as GunItem).ammo = 5;
            this.adrenaline = 100;
        }*/
        //this.inventory.addOrReplaceWeapon(0, "940_pro");
        //(this.inventory.getWeapon(0) as GunItem).ammo = 5;
        // this.inventory.addOrReplaceWeapon(1, "micro_uzi");
        this.inventory.addOrReplaceWeapon(2, "fists");
    }

    setVelocity(xVelocity: number, yVelocity: number): void {
        this.body.setLinearVelocity(Vec2(xVelocity, yVelocity));
        if (xVelocity !== 0 || yVelocity !== 0) {
            this.movesSinceLastUpdate++;
        }
    }

    get position(): Vec2 {
        return this.deathPosition ?? this.body.getPosition();
    }

    get health(): number {
        return this._health;
    }

    set health(health: number) {
        this._health = health;
        if (this._health > 100) this._health = 100;
        this.dirty.health = true;
    }

    get adrenaline(): number {
        return this._adrenaline;
    }

    set adrenaline(adrenaline: number) {
        this._adrenaline = adrenaline;
        if (this._adrenaline < 0) this._adrenaline = 0;
        if (this.adrenaline > 100) this._adrenaline = 100;
        this.dirty.adrenaline = true;
    }

    get zoom(): number {
        return this._zoom;
    }

    set zoom(zoom: number) {
        this._zoom = zoom;
        this.xCullDist = this._zoom * 1.5;
        this.yCullDist = this._zoom * 1.25;
        this.dirty.zoom = true;
    }

    get activeItemDefinition(): MeleeDefinition | GunDefinition | undefined {
        return this.activeItem?.type.definition as MeleeDefinition | GunDefinition;
    }

    give(idString: string): void {
        this.inventory.appendWeapon(idString);
    }

    disableInvulnerability(): void {
        if (this.invulnerable) {
            this.invulnerable = false;
            this.fullDirtyObjects.add(this);
            this.game.fullDirtyObjects.add(this);
        }
    }

    updateVisibleObjects(): void {
        this.movesSinceLastUpdate = 0;

        const approximateX = Math.round(this.position.x / 10) * 10;
        const approximateY = Math.round(this.position.y / 10) * 10;
        this.nearObjects = this.game.getVisibleObjects(this.position);
        const visibleAtZoom = this.game.visibleObjects[this.zoom];

        const newVisibleObjects = new Set<GameObject>(visibleAtZoom !== undefined ? visibleAtZoom[approximateX][approximateY] : this.nearObjects);

        const minX = this.position.x - this.xCullDist;
        const minY = this.position.y - this.yCullDist;
        const maxX = this.position.x + this.xCullDist;
        const maxY = this.position.y + this.yCullDist;

        for (const object of this.game.dynamicObjects) {
            if (object.position.x > minX &&
                object.position.x < maxX &&
                object.position.y > minY &&
                object.position.y < maxY) {
                newVisibleObjects.add(object);
                if (!this.visibleObjects.has(object)) {
                    this.fullDirtyObjects.add(object);
                }
                // make sure this player is added to other players visible objects
                if (!this.dead && object instanceof Player && !object.visibleObjects.has(this)) {
                    object.visibleObjects.add(this);
                    object.fullDirtyObjects.add(this);
                }
            } else if (this.visibleObjects.has(object)) {
                this.deletedObjects.add(object);
            }
        }

        for (const object of newVisibleObjects) {
            if (!this.visibleObjects.has(object)) {
                this.fullDirtyObjects.add(object);
            }
        }

        for (const object of this.visibleObjects) {
            if (!newVisibleObjects.has(object)) {
                this.deletedObjects.add(object);
            }
        }

        this.visibleObjects = newVisibleObjects;
    }

    sendPacket(packet: SendingPacket): void {
        const stream = SuroiBitStream.alloc(packet.allocBytes);
        try {
            packet.serialize(stream);
        } catch (e) {
            console.error("Error serializing packet. Details:", e);
        }

        this.sendData(stream);
    }

    sendData(stream: SuroiBitStream): void {
        try {
            this.socket.send(stream.buffer.slice(0, Math.ceil(stream.index / 8)), true, true);
        } catch (e) {
            console.warn("Error sending packet. Details:", e);
        }
    }

    override damage(amount: number, source?: GameObject, weaponUsed?: ObjectType): void {
        if (this.invulnerable) return;
        // Calculate damage amount
        if (this.health - amount > 100) {
            amount = -(100 - this.health);
        }
        if (this.health - amount <= 0) {
            amount = this.health;
        }
        if (this.dead) amount = 0;

        // Decrease health; update damage done and damage taken
        this.health -= amount;
        if (amount > 0) {
            this.damageTaken += amount;

            if (source instanceof Player) this.hitEffect = true;
        }
        if (source instanceof Player && source !== this) {
            source.damageDone += amount;
        }

        this.partialDirtyObjects.add(this);
        this.game.partialDirtyObjects.add(this);

        // Death logic
        if (this.health <= 0 && !this.dead) {
            this.health = 0;
            this.dead = true;

            // Send kill packets
            if (source instanceof Player) {
                this.killedBy = source;
                if (source !== this) source.kills++;
                source.sendPacket(new KillPacket(source, this, weaponUsed));
                const killMessage = new KillKillFeedMessage(this, source, weaponUsed);
                this.game.killFeedMessages.add(new KillFeedPacket(this, killMessage));
            }

            // Destroy physics body; reset movement and attacking variables
            this.movement.up = false;
            this.movement.down = false;
            this.movement.left = false;
            this.movement.right = false;
            this.attacking = false;
            this.deathPosition = this.position.clone();
            this.game.world.destroyBody(this.body);
            this.game.aliveCountDirty = true;
            this.adrenaline = 0;
            this.action?.cancel();

            this.game.livingPlayers.delete(this);
            this.game.dynamicObjects.delete(this);
            this.game.removeObject(this);

            // Drop loot
            for (let i = 0; i < 3; i++) {
                this.inventory.dropWeapon(i);
            }

            for (const item in this.inventory.items) {
                const count = this.inventory.items[item];
                if (count > 0) {
                    this.game.addLoot(ObjectType.fromString(ObjectCategory.Loot, item), this.position, count);
                    this.inventory.items[item] = 0;
                }
            }

            // Create death marker
            const deathMarker = new DeathMarker(this);
            this.game.dynamicObjects.add(deathMarker);
            this.game.fullDirtyObjects.add(deathMarker);

            // Winning logic
            if (this.game.started) {
                if (this.game.aliveCount === 1) {
                    // End the game in 1 second
                    this.game.over = true;
                    setTimeout(endGame, 1000);

                    // Send game over
                    const lastManStanding: Player = [...this.game.livingPlayers][0];
                    const gameOverPacket = new GameOverPacket(lastManStanding, true);
                    lastManStanding.sendPacket(gameOverPacket);
                } else if (this.game.aliveCount === 0) {
                    this.game.over = true;
                    setTimeout(endGame, 1000);
                }
            }

            // Send game over to dead player
            if (!this.disconnected) {
                this.sendPacket(new GameOverPacket(this, false));
            }
        }
    }

    executeAction(action: Action): void {
        this.action?.cancel();
        this.action = action;
    }

    override serializePartial(stream: SuroiBitStream): void {
        stream.writePosition(this.position);
        stream.writeRotation(this.rotation, 16);
        stream.writeBits(this.animation.type, ANIMATION_TYPE_BITS);
        stream.writeBoolean(this.animation.seq);
        stream.writeBoolean(this.hitEffect);
    }

    override serializeFull(stream: SuroiBitStream): void {
        stream.writeBoolean(this.invulnerable);
        stream.writeObjectType(this.activeItem.type);
    }
}
