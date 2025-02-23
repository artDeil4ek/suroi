// noinspection ES6PreferShortImport
import {
    Config,
    GasMode,
    SpawnMode
} from "./config";

import {
    Box,
    Fixture,
    Settings,
    Vec2,
    World
} from "planck";
import type { WebSocket } from "uWebSockets.js";

import { endGame, type PlayerContainer } from "./server";
import { Map } from "./map";

import { Player } from "./objects/player";
import { Explosion } from "./objects/explosion";
import { v2v } from "./utils/misc";

import { UpdatePacket } from "./packets/sending/updatePacket";
import { type GameObject } from "./types/gameObject";

import { log } from "../../common/src/utils/misc";
import {
    GasState, ObjectCategory, OBJECT_ID_BITS
} from "../../common/src/constants";
import { ObjectType } from "../../common/src/utils/objectType";
import { type GunDefinition } from "../../common/src/definitions/guns";
import { Bullet, DamageRecord } from "./objects/bullet";
import { KillFeedPacket } from "./packets/sending/killFeedPacket";
import { JoinKillFeedMessage } from "./types/killFeedMessage";
import { randomPointInsideCircle } from "../../common/src/utils/random";
import { GasStages } from "./data/gasStages";
import { JoinedPacket } from "./packets/sending/joinedPacket";
import {
    v,
    vClone,
    type Vector
} from "../../common/src/utils/vector";
import {
    distanceSquared,
    lerp,
    vecLerp
} from "../../common/src/utils/math";
import { MapPacket } from "./packets/sending/mapPacket";
import { Loot } from "./objects/loot";
import { IDAllocator } from "./utils/idAllocator";
import { Obstacle } from "./objects/obstacle";

export class Game {
    map: Map;

    /**
     * A cached map packet
     * Since the map is static, there's no reason to serialize a map packet for each player that joins the game
     */
    mapPacket: MapPacket;

    world: World;

    /**
     * The value of `Date.now()`, as of the start of the tick.
     */
    _now = Date.now();
    get now(): number { return this._now; }

    /**
     * A Set of all the static objects in the world
     */
    staticObjects = new Set<GameObject>();
    /**
     * A Set of all the dynamic (moving) objects in the world
     */
    dynamicObjects = new Set<GameObject>();
    visibleObjects: Record<number, Record<number, Record<number, Set<GameObject>>>> = {};
    updateObjects = false;

    aliveCountDirty = false;

    partialDirtyObjects = new Set<GameObject>();
    fullDirtyObjects = new Set<GameObject>();
    deletedObjects = new Set<GameObject>();

    livingPlayers: Set<Player> = new Set<Player>();
    connectedPlayers: Set<Player> = new Set<Player>();

    loot: Set<Loot> = new Set<Loot>();
    explosions: Set<Explosion> = new Set<Explosion>();
    /**
     * All bullets that currently exist
     */
    bullets = new Set<Bullet>();
    /**
     * All bullets created this tick
     */
    newBullets = new Set<Bullet>();
    deletedBulletIDs = new Set<number>();
    /**
     * All records of damage by bullets this tick
     */
    damageRecords = new Set<DamageRecord>();

    /**
     * All kill feed messages this tick
     */
    killFeedMessages = new Set<KillFeedPacket>();

    started = false;
    allowJoin = false;
    over = false;
    stopped = false;

    readonly gas = {
        stage: 0,
        state: GasState.Inactive,
        initialDuration: 0,
        countdownStart: 0,
        percentage: 0,
        oldPosition: v(360, 360),
        newPosition: v(360, 360),
        oldRadius: 512,
        newRadius: 512,
        currentPosition: v(360, 360),
        currentRadius: 512,
        dps: 0,
        ticksSinceLastDamage: 0
    };

    gasDirty = false;
    gasPercentageDirty = false;

    tickTimes: number[] = [];

    constructor() {
        this.world = new World({ gravity: Vec2(0, 0) }); // Create the Planck.js World
        Settings.maxLinearCorrection = 0; // Prevents collision jitter
        Settings.maxTranslation = 12.5; // Allows bullets to travel fast

        // Collision filtering code:
        // - Players should collide with obstacles, but not with each other or with loot.
        // - Bullets should collide with players and obstacles, but not with each other or with loot.
        // - Loot should only collide with obstacles and other loot.
        Fixture.prototype.shouldCollide = function(that: Fixture): boolean {
            // Get the objects
            const thisObject = this.getUserData() as GameObject;
            const thatObject = that.getUserData() as GameObject;

            // Check if they should collide
            if (thisObject.is.player) return thatObject.collidesWith.player;
            else if (thisObject.is.obstacle) return thatObject.collidesWith.obstacle;
            else if (thisObject.is.bullet) return thatObject.collidesWith.bullet;
            else if (thisObject.is.loot) return thatObject.collidesWith.loot;
            else return false;
        };

        // If maxLinearCorrection is set to 0, player collisions work perfectly, but loot doesn't spread out.
        // If maxLinearCorrection is greater than 0, loot spreads out, but player collisions are jittery.
        // This code solves the dilemma by setting maxLinearCorrection to the appropriate value for the object.
        this.world.on("pre-solve", contact => {
            const objectA = contact.getFixtureA().getUserData() as GameObject;
            const objectB = contact.getFixtureB().getUserData() as GameObject;
            if (objectA.is.loot || objectB.is.loot) Settings.maxLinearCorrection = 0.06;
            else Settings.maxLinearCorrection = 0;
        });

        // this return type is technically not true, but it gets typescript to shut up
        const shouldDie = (object: unknown): object is Bullet => object instanceof Bullet && object.distanceSquared <= object.maxDistanceSquared && !object.dead;

        // Handle bullet collisions
        this.world.on("begin-contact", contact => {
            const objectA = contact.getFixtureA().getUserData();
            const objectB = contact.getFixtureB().getUserData();

            if (shouldDie(objectA)) {
                objectA.dead = true;
                this.damageRecords.add(new DamageRecord(objectB as GameObject, objectA.shooter, objectA));
            } else if (shouldDie(objectB)) {
                objectB.dead = true;
                this.damageRecords.add(new DamageRecord(objectA as GameObject, objectB.shooter, objectB));
            }
        });

        // Create world boundaries
        this.createWorldBoundary(360, 0, 360, 0);
        this.createWorldBoundary(0, 360, 0, 360);
        this.createWorldBoundary(360, 720, 360, 0);
        this.createWorldBoundary(720, 360, 0, 360);

        // Generate map
        this.map = new Map(this);

        this.mapPacket = new MapPacket(this);

        this.allowJoin = true;

        // Start the tick loop
        this.tick(30);
    }

    private createWorldBoundary(x: number, y: number, width: number, height: number): void {
        const boundary = this.world.createBody({
            type: "static",
            position: Vec2(x, y)
        });

        boundary.createFixture({
            shape: Box(width, height),
            userData: {
                is: {
                    player: false,
                    obstacle: true,
                    bullet: false,
                    loot: false
                },
                collidesWith: {
                    player: true,
                    obstacle: false,
                    bullet: true,
                    loot: true
                }
            }
        });
    }

    tick(delay: number): void {
        setTimeout((): void => {
            this._now = Date.now();

            if (this.stopped) return;

            // Update loot positions
            for (const loot of this.loot) {
                if (loot.oldPosition.x !== loot.position.x || loot.oldPosition.y !== loot.position.y) {
                    this.partialDirtyObjects.add(loot);
                }
                loot.oldPosition = vClone(loot.position);
            }

            // Update bullets
            for (const bullet of this.bullets) {
                if (bullet.distanceSquared >= bullet.maxDistanceSquared) {
                    if (!bullet.dead) this.removeBullet(bullet);
                    // Note: Bullets that pass their maximum distance are automatically deleted by the client,
                    // so there's no need to add them to the list of deleted bullets
                }
            }

            // Do damage to objects hit by bullets
            for (const damageRecord of this.damageRecords) {
                const bullet = damageRecord.bullet;
                const definition = bullet.source.ballistics;

                if (damageRecord.damaged instanceof Player) {
                    damageRecord.damaged.damage(definition.damage, damageRecord.damager, bullet.sourceType);
                } else if (damageRecord.damaged instanceof Obstacle) {
                    damageRecord.damaged.damage?.(definition.damage * definition.obstacleMultiplier, damageRecord.damager, bullet.sourceType);
                }

                this.removeBullet(bullet);
                this.deletedBulletIDs.add(bullet.id);
            }
            this.damageRecords.clear();

            // Handle explosions
            for (const explosion of this.explosions) {
                explosion.explode();
            }

            // Update gas
            if (this.gas.state !== GasState.Inactive) {
                this.gas.percentage = (this.now - this.gas.countdownStart) / (1000 * this.gas.initialDuration);
                this.gasPercentageDirty = true;
            }

            // Red zone damage
            this.gas.ticksSinceLastDamage++;
            let gasDamage = false;
            if (this.gas.ticksSinceLastDamage >= 30) {
                this.gas.ticksSinceLastDamage = 0;
                gasDamage = true;
                if (this.gas.state === GasState.Advancing) {
                    this.gas.currentPosition = vecLerp(this.gas.oldPosition, this.gas.newPosition, this.gas.percentage);
                    this.gas.currentRadius = lerp(this.gas.oldRadius, this.gas.newRadius, this.gas.percentage);
                }
            }

            // Update physics
            this.world.step(30);

            // First loop over players: Movement, animations, & actions
            for (const player of this.livingPlayers) {
                // This system allows opposite movement keys to cancel each other out.
                const movement: Vector = v(0, 0);

                if (player.isMobile && player.movement.moving) {
                    movement.x = Math.cos(player.movement.angle) * 1.45;
                    movement.y = -Math.sin(player.movement.angle) * 1.45;
                } else {
                    if (player.movement.up) movement.y++;
                    if (player.movement.down) movement.y--;
                    if (player.movement.left) movement.x--;
                    if (player.movement.right) movement.x++;
                }

                // This is the same as checking if they're both non-zero, because if either of them is zero, the product will be zero
                let speed = (movement.x * movement.y !== 0 ? Config.diagonalSpeed : Config.movementSpeed) * (1 + (player.adrenaline / 1000));

                if (player.recoil.active) {
                    if (player.recoil.time < this.now) {
                        player.recoil.active = false;
                    } else {
                        speed *= player.recoil.multiplier;
                    }
                }
                if (player.action) speed *= player.action.speedMultiplier;

                player.setVelocity(movement.x * speed, movement.y * speed);

                if (player.isMoving || player.turning) {
                    player.disableInvulnerability();
                    this.partialDirtyObjects.add(player);
                }

                // Drain adrenaline
                if (player.adrenaline > 0) {
                    player.adrenaline -= 0.015;
                }

                // Regenerate health
                player.health += player.adrenaline * 0.00039;

                // Shoot gun/use melee
                if (player.startedAttacking) {
                    player.startedAttacking = false;
                    player.disableInvulnerability();
                    player.activeItem?.useItem();
                }

                // Gas damage
                if (gasDamage && this.isInGas(player.position)) {
                    player.damage(this.gas.dps);
                }

                player.turning = false;
            }

            // Second loop over players: calculate visible objects & send updates
            for (const player of this.connectedPlayers) {
                if (!player.joined) continue;

                // Calculate visible objects
                if (player.movesSinceLastUpdate > 8 || this.updateObjects) {
                    player.updateVisibleObjects();
                }

                // Full objects
                if (this.fullDirtyObjects.size !== 0) {
                    for (const object of this.fullDirtyObjects) {
                        if (player.visibleObjects.has(object)) {
                            player.fullDirtyObjects.add(object);
                        }
                    }
                }

                // Partial objects
                if (this.partialDirtyObjects.size !== 0) {
                    for (const object of this.partialDirtyObjects) {
                        if (player.visibleObjects.has(object) && !player.fullDirtyObjects.has(object)) {
                            player.partialDirtyObjects.add(object);
                        }
                    }
                }

                // Deleted objects
                if (this.deletedObjects.size !== 0) {
                    for (const object of this.deletedObjects) {
                        if (player.visibleObjects.has(object) && object !== player) {
                            player.deletedObjects.add(object);
                        }
                    }
                }

                for (const message of this.killFeedMessages) player.sendPacket(message);
                player.sendPacket(new UpdatePacket(player));
            }

            // Reset everything
            this.fullDirtyObjects.clear();
            this.partialDirtyObjects.clear();
            this.deletedObjects.clear();
            this.newBullets.clear();
            this.deletedBulletIDs.clear();
            this.explosions.clear();
            this.killFeedMessages.clear();
            this.aliveCountDirty = false;
            this.gasDirty = false;
            this.gasPercentageDirty = false;
            this.updateObjects = false;

            for (const player of this.livingPlayers) {
                player.hitEffect = false;
            }

            // Stop the game in 1 second if there are no more players alive
            if (this.started && this.aliveCount === 0 && !this.over) {
                this.over = true;
                setTimeout(endGame, 1000);
            }

            // Record performance and start the next tick
            // THIS TICK COUNTER IS WORKING CORRECTLY!
            // It measures the time it takes to calculate a tick, not the time between ticks.
            const tickTime = Date.now() - this.now;
            this.tickTimes.push(tickTime);

            if (this.tickTimes.length >= 200) {
                const mspt = this.tickTimes.reduce((a, b) => a + b) / this.tickTimes.length;
                log(`Average ms/tick: ${mspt}`, true);
                log(`Server load: ${((mspt / 30) * 100).toFixed(1)}%`);
                this.tickTimes = [];
            }

            const newDelay = Math.max(0, 30 - tickTime);
            this.tick(newDelay);
        }, delay);
    }

    addPlayer(socket: WebSocket<PlayerContainer>, name: string, isDev: boolean, nameColor: string): Player {
        let spawnPosition = Vec2(0, 0);
        switch (Config.spawn.mode) {
            case SpawnMode.Random: {
                let foundPosition = false;
                while (!foundPosition) {
                    spawnPosition = v2v(this.map.getRandomPositionFor(ObjectType.categoryOnly(ObjectCategory.Player)));
                    if (!this.isInGas(spawnPosition)) foundPosition = true;
                }
                break;
            }
            case SpawnMode.Fixed: {
                spawnPosition = Config.spawn.position;
                break;
            }
            case SpawnMode.Radius: {
                spawnPosition = v2v(randomPointInsideCircle(Config.spawn.position, Config.spawn.radius));
                break;
            }
        }

        // Player is added to the players array when a JoinPacket is received from the client
        return new Player(this, name, socket, spawnPosition, isDev, nameColor);
    }

    // Called when a JoinPacket is sent by the client
    activatePlayer(player: Player): void {
        const game = player.game;

        game.livingPlayers.add(player);
        game.connectedPlayers.add(player);
        game.dynamicObjects.add(player);
        game.fullDirtyObjects.add(player);
        game.updateObjects = true;
        game.aliveCountDirty = true;
        game.killFeedMessages.add(new KillFeedPacket(player, new JoinKillFeedMessage(player, true)));

        player.updateVisibleObjects();
        player.joined = true;
        player.sendPacket(new JoinedPacket(player));
        player.sendPacket(this.mapPacket);

        setTimeout(() => {
            player.disableInvulnerability();
        }, 5000);

        if (this.aliveCount > 1 && !this.started) {
            this.started = true;
            this.advanceGas();

            // Stop new players from joining in the final 30 seconds
            setTimeout(() => {
                this.allowJoin = false;
            }, 145000);
        }
    }

    /**
     * Get the visible objects at a given position and zoom level
     * @param position The position
     * @param zoom The zoom level, defaults to 48
     * @returns A set with the visible game objects at the given position and zoom level
     * @throws {Error} If the zoom level is invalid
     */
    getVisibleObjects(position: Vector, zoom = 48): Set<GameObject> {
        if (this.visibleObjects[zoom] === undefined) throw new Error(`Invalid zoom level: ${zoom}`);
        // return an empty set if the position is out of bounds
        if (position.x < 0 || position.x > this.map.width ||
            position.y < 0 || position.y > this.map.height) return new Set();
        return this.visibleObjects[zoom][Math.round(position.x / 10) * 10][Math.round(position.y / 10) * 10];
    }

    removePlayer(player: Player): void {
        player.disconnected = true;
        this.aliveCountDirty = true;
        if (!player.dead) {
            this.killFeedMessages.add(new KillFeedPacket(player, new JoinKillFeedMessage(player, false)));
        }
        this.connectedPlayers.delete(player);

        if (player.canDespawn) {
            this.livingPlayers.delete(player);
            this.dynamicObjects.delete(player);
            this.removeObject(player);
            this.world.destroyBody(player.body);
        }
        try {
            player.socket.close();
        } catch (e) { }
    }

    addLoot(type: ObjectType, position: Vector, count?: number): Loot {
        const loot = new Loot(this, type, position, count);
        this.loot.add(loot);
        this.dynamicObjects.add(loot);
        this.fullDirtyObjects.add(loot);
        this.updateObjects = true;
        return loot;
    }

    removeLoot(loot: Loot): void {
        this.loot.delete(loot);
        this.dynamicObjects.delete(loot);
        this.world.destroyBody(loot.body);
        this.removeObject(loot);
    }

    addBullet(position: Vec2, rotation: number, source: GunDefinition, sourceType: ObjectType, shooter: Player): Bullet {
        const bullet = new Bullet(this,
            position,
            rotation,
            source,
            sourceType,
            shooter);
        this.bullets.add(bullet);
        this.newBullets.add(bullet);

        return bullet;
    }

    /**
     * Delete a bullet and give the id back to the allocator
     * @param bullet The bullet to delete
     */
    removeBullet(bullet: Bullet): void {
        this.bulletIDAllocator.give(bullet.id);
        this.world.destroyBody(bullet.body);
        this.bullets.delete(bullet);
    }

    addExplosion(type: ObjectType, position: Vector, source: GameObject): Explosion {
        const explosion = new Explosion(this, type, position, source);
        this.explosions.add(explosion);
        return explosion;
    }

    /**
     * Delete an object and give the id back to the allocator
     * @param object The object to delete
     */
    removeObject(object: GameObject): void {
        this.idAllocator.give(object.id);
        this.updateObjects = true;
    }

    get aliveCount(): number {
        return this.livingPlayers.size;
    }

    advanceGas(): void {
        if (Config.gas.mode === GasMode.Disabled) return;
        const currentStage = GasStages[this.gas.stage + 1];
        if (currentStage === undefined) return;
        const duration = Config.gas.mode === GasMode.Debug && currentStage.duration !== 0 ? Config.gas.overrideDuration : currentStage.duration;
        this.gas.stage++;
        this.gas.state = currentStage.state;
        this.gas.initialDuration = duration;
        this.gas.percentage = 1;
        this.gas.countdownStart = this.now;
        if (currentStage.state === GasState.Waiting) {
            this.gas.oldPosition = vClone(this.gas.newPosition);
            if (currentStage.newRadius !== 0) {
                this.gas.newPosition = randomPointInsideCircle(this.gas.oldPosition, currentStage.oldRadius - currentStage.newRadius);
            } else {
                this.gas.newPosition = vClone(this.gas.oldPosition);
            }
            this.gas.currentPosition = vClone(this.gas.oldPosition);
            this.gas.currentRadius = currentStage.oldRadius;
        }
        this.gas.oldRadius = currentStage.oldRadius;
        this.gas.newRadius = currentStage.newRadius;
        this.gas.dps = currentStage.dps;
        this.gasDirty = true;
        this.gasPercentageDirty = true;

        // Start the next stage
        if (duration !== 0) {
            setTimeout(() => this.advanceGas(), duration * 1000);
        }
    }

    isInGas(position: Vector): boolean {
        return distanceSquared(position, this.gas.currentPosition) >= this.gas.currentRadius ** 2;
    }

    idAllocator = new IDAllocator(OBJECT_ID_BITS);

    get nextObjectID(): number {
        return this.idAllocator.takeNext();
    }

    bulletIDAllocator = new IDAllocator(8);

    get nextBulletID(): number {
        return this.bulletIDAllocator.takeNext();
    }
}
