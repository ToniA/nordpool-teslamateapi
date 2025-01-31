// Charging should be ready by this full hour, like 7:00 (24h, i.e. 7AM)
// Array starting from Sunday. Example: ready by 07:00 on Mon-Fri, 08:00 on Sat-Sun
const chargeReadyHour = [ 8, 7, 7, 7, 7, 7, 8 ]

// Caruna grid fee + electricity tax + Vaasan Sähkö spot commission, €/kWh
const basePrice =  0.0323 + 0.02827515 + 0.0041

// 3-phase charge
const chargePhases = 3

// How many percentage points of charge the car gains in one hour
const chargeSpeeds = [
    {
        amps: 10,
        chargePercentagePointsPerHour: 9,
        efficiency: 0.92
    },
    {
        amps: 16,
        chargePercentagePointsPerHour: 14,
        efficiency: 0.85
    }
]

// How many percentage points the charge rate drops below 0°C, per each °
const chargePercentagePointsPerHourColdFactor = 0.07

// On which hour to start charging if anything fails
const fallbackChargeStartHour = 23

try {
    // 'Car Dashboards' saves the topics into global context in format [value, timestamp]
    const battery_level = global.get("battery_level")[0]
    const charging_state = global.get("charging_state")[0]
    const charge_limit_soc = global.get("charge_limit_soc")[0]
    const outside_temp = global.get("outside_temp")[0]
    const scheduled_charging_start_time = global.get("scheduled_charging_start_time")[0]

    node.warn(`Battery ${battery_level}%, charge limit: ${charge_limit_soc}%`)
    node.warn(`Charging state: ${charging_state}, outside temperature: ${outside_temp}`)
    node.warn(`Charge scheduled at: ${scheduled_charging_start_time || "-"}`)

    if (scheduled_charging_start_time == "" || !(charging_state == "Stopped" || charging_state == "NoPower")) {
        node.status({ text: `Not plugged in with scheduled charge: ${charging_state || "-"}` })
        return null
    }

    const chargeHourAlternatives = chargeSpeeds.map( obj => (
        {...obj,
            hours: (charge_limit_soc - battery_level) / (obj.chargePercentagePointsPerHour + chargePercentagePointsPerHourColdFactor * (outside_temp < 0 ? outside_temp : 0))
        }))

    const nordpoolPrices = Enumerable.from(msg.payload.map(pricePoint => (
        {
            date: new Date(pricePoint.DateTime),
            value: pricePoint.PriceWithTax
        }
    )))

    // Charge window start is the next full hour
    let chargeStartTime = new Date()
    chargeStartTime.setHours(chargeStartTime.getHours() + 1)
    chargeStartTime.setMinutes(0, 0, 0)

    // Charge window end
    let chargeEndTime = new Date(chargeStartTime)
    chargeEndTime.setHours(chargeReadyHour[chargeEndTime.getDay()], 0, 0, 0)

    if (chargeStartTime > chargeEndTime) {
        chargeEndTime.setDate(chargeEndTime.getDate() + 1)
    }

    const pricesDuringChargeWindow = nordpoolPrices.where(
        i => new Date(i.date).getTime() >= chargeStartTime.getTime()
            && new Date(i.date).getTime() <= chargeEndTime.getTime()
    )

    const cheapestStartHourAlternatives = chargeHourAlternatives.map( chargeHourAlternative => {
        const hoursToConsider = pricesDuringChargeWindow.take(pricesDuringChargeWindow.count() - Math.ceil(chargeHourAlternative.hours)).toArray()

        const cheapestStartHour = Enumerable.from(hoursToConsider.map(
            (price, index) => (
                {
                    date: price.date,
                    price: pricesDuringChargeWindow.skip(index).take(Math.ceil(chargeHourAlternative.hours)).sum(i => (basePrice + i.value) / chargeHourAlternative.efficiency * (230 * chargeHourAlternative.amps * chargePhases / 1000))
                })
        )).orderBy(i => i.price).first()

        const startHour = new Date(cheapestStartHour.date).getHours()

        return {
            startTime: cheapestStartHour.date,
            startHour: startHour,
            chargeHours: chargeHourAlternative.hours.toFixed(1),
            amps: chargeHourAlternative.amps,
            price: cheapestStartHour.price
        }
    })

    const cheapestStartHour = Enumerable.from(cheapestStartHourAlternatives).orderBy(i => i.price).first()

    const startTime = cheapestStartHour.startTime
    const startHour = cheapestStartHour.startHour
    const startDelay = startTime.getTime() - new Date().getTime() - 60 * 1000
    const chargeAmps = cheapestStartHour.amps
    const price = cheapestStartHour.price.toFixed(2)

    node.status({ text: `Charge at: ${startHour.toString().padStart(2, '0')}:00 for ${cheapestStartHour.chargeHours} hours at ${chargeAmps}A, estimate ${price}€` })

    return [
        {
            "delay": startDelay.toString()
        },
        {
            "payload": {
                "time": startHour * 60,
                "enable": "true"
            }
        },
        {
            "payload": {
                "charging_amps": chargeAmps
            }
        }
    ]
} catch (e) {
    node.warn(`Exception: ${e}`)
    node.status({ text: `Failure, charge at ${fallbackChargeStartHour}:00` })

    // defaults:
    // * 4 minutes delay -> 22:59 if this executes at 22:55
    // * 23:00 charge start time
    // * 10A charging amps
    return [
        {
            "delay": (4 * 60 * 1000).toString()
        },
        {
            "payload": {
                "time": fallbackChargeStartHour * 60,
                "enable": "true"
            }
        },
        {
            "payload": {
                "charging_amps": 10
            }
        }
    ]
}